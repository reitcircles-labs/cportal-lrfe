/**
 * Seeded randomness for the test register (API-769): the same seed gives the same register, to
 * the byte. Names of people, companies, places and farms are made up from syllables, so the
 * register holds no real person's data.
 */

/** A pseudo-random generator (mulberry32) with the helpers the register needs. */
export function createRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const digits = n => Array.from({length: n}, () => int(0, 9)).join('');
  return {
    next,
    int,
    digits,
    pick: list => list[Math.floor(next() * list.length)],
    chance: probability => next() < probability,
    /** A version 4 UUID from this generator, so ids repeat with the seed. */
    uuid() {
      const hex = Array.from({length: 32}, () => int(0, 15).toString(16));
      hex[12] = '4';
      // the variant: the top two bits of this digit are 10
      hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
      const parts = [];
      let at = 0;
      for (const length of [8, 4, 4, 4, 12]) {
        parts.push(hex.slice(at, at + length).join(''));
        at += length;
      }
      return parts.join('-');
    },
  };
}

const ONSETS = ['', 'b', 'd', 'g', 'h', 'k', 'l', 'm', 'n', 'nd', 'ng', 'p'];
const MORE_ONSETS = ['r', 's', 't', 'v', 'w', 'z', 'tj', 'kh', 'sh', 'br'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'aa', 'ee', 'ai', 'au'];
const CODAS = ['', '', '', 'n', 'm', 'r', 's', 'l', 'k'];

/** A made-up word of `min` to `max` syllables, capitalised: "Kanduro", "Tjeesam". */
export function madeUpWord(random, min = 2, max = 3) {
  const syllables = random.int(min, max);
  let word = '';
  for (let i = 0; i < syllables; i++) {
    const onsets = random.chance(0.3) ? MORE_ONSETS : ONSETS;
    word += random.pick(onsets) + random.pick(VOWELS);
    if (i === syllables - 1) word += random.pick(CODAS);
  }
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A made-up person: "Tavo Kemaris", with an ID number of `idDigits` digits starting with a birth date. */
export function madeUpPerson(random, idDigits) {
  const name = `${madeUpWord(random, 2, 2)} ${madeUpWord(random, 2, 4)}`;
  const twoDigits = n => String(n).padStart(2, '0');
  const year = random.digits(2);
  const month = twoDigits(random.int(1, 12));
  const day = twoDigits(random.int(1, 28));
  const rest = random.digits(Math.max(0, idDigits - 6));
  return {name, idNo: `${year}${month}${day}${rest}`};
}

const COMPANY_KINDS = [
  'Investments (Pty) Ltd',
  'Properties (Pty) Ltd',
  'Holdings CC',
  'Family Trust',
  'Development Company (Pty) Ltd',
];

/** A made-up company or trust, with a registration number like "2008/1234". */
export function madeUpCompany(random) {
  return {
    name: `${madeUpWord(random, 2, 3)} ${random.pick(COMPANY_KINDS)}`,
    idNo: `${random.int(1960, 2024)}/${random.int(100, 9999)}`,
  };
}
