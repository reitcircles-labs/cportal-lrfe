// Set a user's password (and optionally reset their MFA) directly in the identity database.
//
//   npm run reset-password -w @lrfe/identity -- <email>                 asks for the new password
//   npm run reset-password -w @lrfe/identity -- <email> --from-env      uses BOOTSTRAP_ADMIN_PASSWORD
//   npm run reset-password -w @lrfe/identity -- <email> --reset-mfa     also re-enrol the authenticator
//
// Uses DB_CONNECTION_STRING from services/identity/.env (npm -w runs in that directory). Without a
// terminal the password is read from the first line of stdin.
import { createInterface } from 'node:readline';
import { createSequelize } from '@lrfe/common';
import { createSequelizeRepo } from '../src/repo/sequelize.js';
import { MIN_PASSWORD_LENGTH, resetPassword } from '../src/reset-password.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const [email] = args.filter(a => !a.startsWith('--'));
const unknown = [...flags].filter(f => !['--from-env', '--reset-mfa'].includes(f));
if (!email || unknown.length) {
    console.error('Usage: npm run reset-password -w @lrfe/identity -- <email> [--from-env] [--reset-mfa]');
    if (unknown.length) console.error(`Unknown option(s): ${unknown.join(', ')}`);
    process.exit(1);
}

/** Read a line from the terminal without echoing it. */
function askHidden(question) {
    return new Promise(resolve => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
        rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    });
}

async function firstLine() {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) { rl.close(); return line; }
    return '';
}

async function getPassword() {
    if (flags.has('--from-env')) {
        if (!process.env.BOOTSTRAP_ADMIN_PASSWORD) throw new Error('BOOTSTRAP_ADMIN_PASSWORD is not set in .env');
        return process.env.BOOTSTRAP_ADMIN_PASSWORD;
    }
    if (!process.stdin.isTTY) return firstLine();
    const first = await askHidden(`New password for ${email} (at least ${MIN_PASSWORD_LENGTH} characters): `);
    const again = await askHidden('Repeat it: ');
    if (first !== again) throw new Error('The two passwords do not match');
    return first;
}

let sequelize;
try {
    const password = await getPassword();
    sequelize = createSequelize();
    const { user, warnings } = await resetPassword(createSequelizeRepo(sequelize), { email, password, resetMfa: flags.has('--reset-mfa') });
    console.log(`Password reset for ${user.name} <${user.email}>; their sessions were ended.`);
    if (flags.has('--reset-mfa')) console.log('MFA reset: they enrol a new authenticator at the next sign-in.');
    for (const w of warnings) console.warn(`Note: ${w}`);
} catch (err) {
    console.error(`Not changed: ${err.message}`);
    process.exitCode = 1;
} finally {
    await sequelize?.close();
}
