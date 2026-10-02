import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));

/** Process definitions ship as JSON files in this folder and are deployed at boot. */
export async function loadDefinitions(dir = DIR) {
    const files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort();
    return Promise.all(files.map(async f => JSON.parse(await readFile(`${dir}/${f}`, 'utf8'))));
}

/** Deploy every bundled definition; unchanged ones are skipped. */
export async function deployAll(engine, { log = () => {} } = {}) {
    for (const def of await loadDefinitions()) {
        const { definition, deployed } = await engine.deployDefinition(def);
        if (deployed) log(`deployed ${definition.key} v${definition.version}`);
    }
}
