#!/usr/bin/env python3
"""The test register's encrypted file directory (API-810).

The PostgreSQL test stack with E2E_STORE_DIR keeps the stored files (edrms' and intake's) in
<E2E_STORE_DIR>/files, a directory encrypted by the ext4 file system (fscrypt), as an install
keeps the search engine's directory (deploy/scripts/search_dir.py, README.md part H). The same
code does the work; only the key's source differs: the stack's own OpenBao (backend/scripts/bao.js
--dev, its data in <E2E_STORE_DIR>/bao), reached over HTTP with the root token of its
development set-up, and its key scale-files-dir.

  python3 scripts/scale/files_dir.py --store <E2E_STORE_DIR> --bao <address> create|unlock|lock|status

The stack runs create (first run) or unlock itself once its OpenBao is up; by hand only lock and
status are needed. Development and test registers only: an install uses search_dir.py.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'deploy', 'scripts'),
)
import search_dir  # noqa: E402  (the fscrypt commands, shared with the install)

KEY_NAME = 'scale-files-dir'


class StackStore:
    """The test stack's kept store: what search_dir's commands need of an install."""

    def __init__(self, store: str, bao: str):
        self.dir = os.path.join(os.path.abspath(store), 'files')
        self.wrapped_key_file = self.dir + '.wrapped-key'
        self.min_free_gb = 10
        self.bao = bao.rstrip('/')
        self.init_file = os.path.join(os.path.abspath(store), 'bao', 'dev-init.json')

    def _call(self, path: str, body: dict) -> dict:
        try:
            with open(self.init_file, encoding='utf8') as f:
                token = json.load(f)['rootToken']
        except OSError as err:
            raise search_dir.Refusal(f'{self.init_file}: {err.strerror} (start the stack first)')
        request = urllib.request.Request(
            f'{self.bao}/v1/{path}',
            data=json.dumps(body).encode(),
            headers={'X-Vault-Token': token, 'Content-Type': 'application/json'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as res:
                text = res.read().decode()
                return json.loads(text) if text else {}
        except (urllib.error.URLError, OSError) as err:
            raise search_dir.Refusal(f'OpenBao at {self.bao} did not answer ({err})')

    def ask_openbao(self, command: str, given: str = '') -> str:
        """As the install's one-shot service: 'new' (a wrapped key) or 'unwrap'."""
        # made on first use; creating an existing key changes nothing
        self._call(f'transit/keys/{KEY_NAME}', {})
        if command == 'new':
            answer = self._call(f'transit/datakey/plaintext/{KEY_NAME}', {'bits': 512})
            return json.dumps(answer)
        answer = self._call(f'transit/decrypt/{KEY_NAME}', {'ciphertext': given})
        return answer['data']['plaintext']


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="The test register's encrypted file directory.")
    parser.add_argument('--store', required=True, help='E2E_STORE_DIR')
    parser.add_argument('--bao', required=True, help="the stack's OpenBao, e.g. http://127.0.0.1:3807")
    parser.add_argument('command', choices=['create', 'unlock', 'lock', 'status'])
    args = parser.parse_args(argv)
    store = StackStore(args.store, args.bao)
    try:
        if args.command == 'status':
            return 0 if search_dir.print_status(search_dir.status(store)) else 1
        {'create': search_dir.create, 'unlock': search_dir.unlock, 'lock': search_dir.lock}[
            args.command
        ](store)
        return 0
    except search_dir.Refusal as err:
        print(f'Not done: {err}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
