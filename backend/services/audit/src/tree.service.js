import {BadRequestError, NotFoundError} from '@lrfe/common';
import {
  consistencyPositions,
  inclusionPositions,
  LEAF_TYPES,
  leafHash,
  nodeCount,
  nodeHash,
  peaks,
  rootOf,
} from './mmr.js';

const hex = b => b.toString('hex');
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The growing Merkle tree (README.md section 2) over every committed land record version, every
 * EDRMS document version and the trail's checkpoints. Leaves are added once each (by `key`), in
 * the order they arrive; the root of any size so far, and inclusion and consistency proofs, are
 * read from the stored nodes.
 */
export class TreeService {
  constructor({repo, clock = () => new Date(), logger = console}) {
    this.repo = repo;
    this.clock = clock;
    this.logger = logger;
  }

  /**
   * Add leaves `{ key, type, item, eventId? }` (item: 64 hex characters), one writer at a time.
   * Keys already in the tree are skipped, so a repeated event adds nothing. Returns the leaves added.
   */
  async append(items) {
    for (const it of items) {
      if (
        !it.key ||
        !Object.values(LEAF_TYPES).includes(it.type) ||
        !HEX64.test(it.item || '')
      ) {
        throw new BadRequestError(`Not a tree leaf: ${JSON.stringify(it)}`);
      }
    }
    return this.repo.withTreeLock(async tree => {
      const existing = new Set(await tree.existingKeys(items.map(i => i.key)));
      // a key comes back with another seal: the first one stays; this must not pass unnoticed
      const repeats = items.filter(i => existing.has(i.key));
      const recorded = repeats.length
        ? await tree.itemsByKeys(repeats.map(i => i.key))
        : new Map();
      for (const it of repeats) {
        if (recorded.has(it.key) && recorded.get(it.key) !== it.item) {
          this.logger.warn?.(
            {
              key: it.key,
              stored: recorded.get(it.key),
              offered: it.item,
              eventId: it.eventId,
            },
            'audit tree: a recorded item came again with a different seal; the first one is kept',
          );
        }
      }
      const fresh = items.filter(
        i => !existing.has(i.key) && existing.add(i.key),
      );
      if (!fresh.length) return [];
      let n = await tree.leafCount();
      // only the current peaks are needed: each new leaf merges with peaks of its own height
      const current = peaks(n);
      const stored = await tree.getNodes(current.map(p => p.pos));
      const stack = current.map(p => ({
        height: p.height,
        hash: stored.get(p.pos),
      }));
      let pos = nodeCount(n);
      const leaves = [];
      const nodes = [];
      const added = [];
      const createdAt = this.clock();
      for (const it of fresh) {
        const hash = leafHash(it.type, it.item);
        nodes.push({pos, hash});
        leaves.push({
          leafIndex: n,
          key: it.key,
          type: it.type,
          item: it.item,
          eventId: it.eventId ?? null,
          createdAt,
        });
        added.push({
          index: n,
          key: it.key,
          type: it.type,
          item: it.item,
          hash: hex(hash),
        });
        stack.push({height: 0, hash});
        pos++;
        while (
          stack.length > 1 &&
          stack.at(-1).height === stack.at(-2).height
        ) {
          const right = stack.pop();
          const left = stack.pop();
          const parent = nodeHash(left.hash, right.hash);
          nodes.push({pos, hash: parent});
          stack.push({height: left.height + 1, hash: parent});
          pos++;
        }
        n++;
      }
      await tree.insert(leaves, nodes);
      return added;
    });
  }

  async size() {
    return this.repo.tree.leafCount();
  }

  /** The root of the tree as it was at `size` leaves (default: now). */
  async root(size) {
    const n = size ?? (await this.size());
    await this.checkSize(n);
    const ps = peaks(n);
    const stored = await this.repo.tree.getNodes(ps.map(p => p.pos));
    return {
      size: n,
      root: hex(
        rootOf(
          n,
          ps.map(p => this.node(stored, p.pos)),
        ),
      ),
    };
  }

  /** Proof that the leaf `key` is in the tree of `size` leaves (default: now). */
  async inclusionProof(key, size) {
    const leaf = await this.repo.tree.leafByKey(key);
    if (!leaf) {
      throw new NotFoundError(`Nothing recorded in the tree as ${key}`);
    }
    const n = size ?? (await this.size());
    await this.checkSize(n);
    if (leaf.leafIndex >= n) {
      throw new BadRequestError(
        `${key} was added after the tree had ${n} leaves`,
      );
    }
    const at = inclusionPositions(leaf.leafIndex, n);
    const stored = await this.repo.tree.getNodes([...at.path, ...at.peaks]);
    const peakHashes = at.peaks.map(p => this.node(stored, p));
    return {
      leaf: {
        key: leaf.key,
        type: leaf.type,
        item: leaf.item,
        index: leaf.leafIndex,
        hash: hex(leafHash(leaf.type, leaf.item)),
      },
      size: n,
      path: at.path.map(p => hex(this.node(stored, p))),
      peaks: peakHashes.map(hex),
      root: hex(rootOf(n, peakHashes)),
    };
  }

  /** Proof that the tree of `oldSize` leaves is the start of the tree of `newSize` (default: now). */
  async consistencyProof(oldSize, newSize) {
    const n = newSize ?? (await this.size());
    await this.checkSize(n);
    if (!(Number.isSafeInteger(oldSize) && oldSize >= 1 && oldSize <= n)) {
      throw new BadRequestError(
        `No consistency proof from ${oldSize} to ${n} leaves`,
      );
    }
    const at = consistencyPositions(oldSize, n);
    const stored = await this.repo.tree.getNodes([
      ...at.oldPeaks,
      ...at.newPeaks,
      ...at.paths.flat(),
    ]);
    const get = p => hex(this.node(stored, p));
    const oldPeaks = at.oldPeaks.map(get);
    const newPeaks = at.newPeaks.map(get);
    return {
      oldSize,
      newSize: n,
      oldRoot: hex(rootOf(oldSize, oldPeaks)),
      newRoot: hex(rootOf(n, newPeaks)),
      oldPeaks,
      newPeaks,
      paths: at.paths.map(path => path.map(get)),
    };
  }

  async checkSize(n) {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new BadRequestError(`Not a tree size: ${n}`);
    }
    if (n > (await this.size())) {
      throw new BadRequestError(`The tree has fewer than ${n} leaves`);
    }
  }

  node(stored, pos) {
    const h = stored.get(pos);
    if (!h) throw new Error(`tree: node ${pos} is missing from storage`);
    return h;
  }

  // ------------------------------------------------ leaf sources

  /** The leaf an event adds, or null: a committed land record version or a filed/amended document version. */
  static leafOf(event) {
    const d = event?.data || {};
    if (!HEX64.test(d.seal || '')) return null;
    if (
      event.type === 'records.record.committed' &&
      d.recordId &&
      d.versionNumber
    ) {
      return {
        key: `record-version:${d.recordId}:${d.versionNumber}`,
        type: LEAF_TYPES.recordVersion,
        item: d.seal,
        eventId: event.id,
      };
    }
    if (event.type === 'edrms.document.filed' && d.documentId) {
      return {
        key: `document-version:${d.documentId}:1`,
        type: LEAF_TYPES.documentVersion,
        item: d.seal,
        eventId: event.id,
      };
    }
    if (event.type === 'edrms.document.amended' && d.documentId && d.version) {
      return {
        key: `document-version:${d.documentId}:${d.version}`,
        type: LEAF_TYPES.documentVersion,
        item: d.seal,
        eventId: event.id,
      };
    }
    return null;
  }

  /** The consumer's handler: add the event's leaf, if it has one (again on redelivery: a no-op). */
  async fromEvent(event) {
    const leaf = TreeService.leafOf(event);
    return leaf ? ((await this.append([leaf]))[0] ?? null) : null;
  }

  /** A checkpoint of the trail: its head `{ seq, hash }` as a leaf (once per batch, API-657). */
  async checkpoint(head) {
    if (!head?.seq || !HEX64.test(head.hash || '')) {
      throw new BadRequestError(
        'A checkpoint needs the trail head (seq, hash)',
      );
    }
    return (
      (
        await this.append([
          {
            key: `trail-checkpoint:${head.seq}`,
            type: LEAF_TYPES.trailCheckpoint,
            item: head.hash,
          },
        ])
      )[0] ?? null
    );
  }
}
