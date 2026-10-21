import {PageSizes, rgb} from 'pdf-lib';

/** The extract's colours: ink, muted text, rules, the check box and the warning box. */
export const COLOURS = Object.freeze({
  ink: rgb(0.11, 0.14, 0.19),
  muted: rgb(0.31, 0.35, 0.41),
  rule: rgb(0.87, 0.89, 0.92),
  panel: rgb(0.95, 0.96, 0.98),
  warning: rgb(1, 0.96, 0.86),
  warningEdge: rgb(0.85, 0.65, 0.2),
});

/** Page margins, in points (A4 is 595 × 842). */
export const MARGIN = 48;

/** Room kept free at the bottom of every page for the footer. */
const FOOTER_ROOM = 56;

/**
 * Writes the extract top to bottom over as many A4 pages as it needs: text wrapped to a width, a
 * new page when the next block does not fit. Characters the standard fonts cannot print are
 * written without their accents, or as "?" (printable).
 */
export class PageWriter {
  constructor(pdfDoc, fonts) {
    this.pdfDoc = pdfDoc;
    this.fonts = fonts; // {regular, bold, italic, mono}
    this.charsets = new Map();
    this.page = null;
    this.y = 0;
    this.newPage();
  }

  get width() {
    return this.page.getWidth() - 2 * MARGIN;
  }

  newPage() {
    this.page = this.pdfDoc.addPage(PageSizes.A4);
    this.y = this.page.getHeight() - MARGIN;
  }

  /** A new page unless `height` points still fit above the footer. */
  ensure(height) {
    if (this.y - height < FOOTER_ROOM) this.newPage();
  }

  /** `text` as the font can print it: accents dropped where needed, else "?". */
  printable(text, font) {
    if (!this.charsets.has(font)) {
      this.charsets.set(font, new Set(font.getCharacterSet()));
    }
    const charset = this.charsets.get(font);
    const fits = ch => [...ch].every(c => charset.has(c.codePointAt(0)));
    return [...String(text ?? '').normalize('NFC')]
      .map(ch => {
        if (fits(ch)) return ch;
        const plain = ch.normalize('NFD').replace(/\p{M}/gu, '');
        return plain && fits(plain) ? plain : '?';
      })
      .join('');
  }

  /** `text` in lines no wider than `width`; a word too long for a line (a URL, a hash) is cut. */
  wrap(text, {font = this.fonts.regular, size = 10, width = this.width} = {}) {
    const fitsIn = line => font.widthOfTextAtSize(line, size) <= width;
    const lines = [];
    let line = '';
    const words = this.printable(text, font).split(/\s+/).filter(Boolean);
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (fitsIn(candidate)) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      let rest = word;
      while (!fitsIn(rest)) {
        let cut = rest.length - 1;
        while (cut > 1 && !fitsIn(rest.slice(0, cut))) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * Writes `text` wrapped at `x` (from the margin) within `width`, moving down; returns the height
   * used. With `dryRun`, only measures.
   */
  text(
    text,
    {
      font = this.fonts.regular,
      size = 10,
      x = 0,
      width = this.width - x,
      colour = COLOURS.ink,
      lineGap = 1.35,
      dryRun = false,
    } = {},
  ) {
    const lines = this.wrap(text, {font, size, width});
    const lineHeight = size * lineGap;
    if (dryRun) return lines.length * lineHeight;
    for (const line of lines) {
      this.page.drawText(line, {
        x: MARGIN + x,
        y: this.y - size,
        size,
        font,
        color: colour,
      });
      this.y -= lineHeight;
    }
    return lines.length * lineHeight;
  }

  /** `text` on one line, its right end at the right margin, `top` points below the page top. */
  textRight(
    text,
    {font = this.fonts.regular, size = 10, top, colour = COLOURS.ink},
  ) {
    const line = this.printable(text, font);
    this.page.drawText(line, {
      x: this.page.getWidth() - MARGIN - font.widthOfTextAtSize(line, size),
      y: this.page.getHeight() - MARGIN - top - size,
      size,
      font,
      color: colour,
    });
  }

  /** A thin horizontal rule across the text width, with `gap` points around it. */
  rule(gap = 10) {
    this.y -= gap;
    this.page.drawLine({
      start: {x: MARGIN, y: this.y},
      end: {x: MARGIN + this.width, y: this.y},
      thickness: 0.6,
      color: COLOURS.rule,
    });
    this.y -= gap;
  }

  /** Moves down `points`. */
  space(points) {
    this.y -= points;
  }
}
