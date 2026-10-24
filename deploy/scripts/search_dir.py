#!/usr/bin/env python3
"""The search engine's encrypted data directory (API-799).

Run on the server, as the user who runs Docker, in the bundle's folder (deploy/ in the repository):

  python3 scripts/search_dir.py create    make OPENSEARCH_DATA_DIR and encrypt it
  python3 scripts/search_dir.py unlock    after every reboot, before the search engine starts
  python3 scripts/search_dir.py lock      the search engine stopped first
  python3 scripts/search_dir.py status [--json]

Options before the command: --env <file> (default .env beside docker-compose.yml) and
--project <name> (default lrfe), for another install of the same compose file.

The directory is encrypted by the ext4 file system itself (fscrypt, v2 policy): file names and
contents, with a 512-bit key that OpenBao makes and wraps with its key search-dir. Only the wrapped
key is kept, in <directory>.wrapped-key beside the directory; it is useless without OpenBao. The
plain key travels from OpenBao to the kernel through a pipe and memory only (the one-shot compose
service search-dir-key), never into a file. Once the key is added, every process on the server
sees ordinary files, the search engine's container too; without it, nothing can be read or written.

Needs, once per server, the ext4 feature "encrypt" on the directory's file system (README.md,
part H: one root step). Everything here runs without root. Linux 5.4 or later (v2 policies),
Python 3.8 or later, standard library only.
"""

import argparse
import base64
import errno
import fcntl
import json
import os
import shutil
import struct
import subprocess
import sys
from typing import Dict, Optional

# the folder of docker-compose.yml: the bundle's folder, or deploy/ in the repository
DEPLOY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The file inside the directory that the start guard (compose service search-dir-check) looks
# for: it is readable only while the directory is unlocked.
MARKER = '.lrfe-encrypted'
MARKER_TEXT = (
    'The search engine\'s encrypted directory (API-799). Created by scripts/search_dir.py;\n'
    'never create this file by hand: the search engine starts only where it is found.\n'
)
# Free space below which the readiness check warns (OPENSEARCH_MIN_FREE_GB), in GB.
DEFAULT_MIN_FREE_GB = 100

# The kernel's fscrypt interface (linux/fscrypt.h, kernel 5.4 or later).
FS_IOC_SET_ENCRYPTION_POLICY = 0x800C6613
FS_IOC_GET_ENCRYPTION_POLICY_EX = 0xC0096616
FS_IOC_ADD_ENCRYPTION_KEY = 0xC0506617
FS_IOC_REMOVE_ENCRYPTION_KEY = 0xC0406618
FS_IOC_GET_ENCRYPTION_KEY_STATUS = 0xC080661A
POLICY_V2 = 2
MODE_AES_256_XTS = 1  # contents
MODE_AES_256_CTS = 4  # file names
POLICY_FLAGS_PAD_32 = 0x03
KEY_SPEC_TYPE_IDENTIFIER = 2
KEY_STATUS_PRESENT = 2
KEY_STATUS_INCOMPLETELY_REMOVED = 3
REMOVAL_FLAG_FILES_BUSY = 0x01
REMOVAL_FLAG_OTHER_USERS = 0x02
KEY_BYTES = 64  # AES-256-XTS needs 512 bits
POLICY_V2_SIZE = 24
KEY_SPEC_SIZE = 40  # type, reserved, 32 bytes of identifier


class Refusal(Exception):
    """A stop with a message for the person running the script (and what to do)."""


# ------------------------------------------------------------------------------------------- kernel


def _key_spec(identifier: bytes) -> bytes:
    """A key specifier naming a v2 key by its 16-byte identifier."""
    return struct.pack('=II32s', KEY_SPEC_TYPE_IDENTIFIER, 0, identifier)


def get_policy(fd: int) -> Optional[bytes]:
    """The directory's v2 key identifier, or None when it is not encrypted.

    Raises Refusal when the file system has no encryption switched on, or the directory has an
    older (v1) policy.
    """
    buf = bytearray(struct.pack('=Q', POLICY_V2_SIZE) + bytes(POLICY_V2_SIZE))
    try:
        fcntl.ioctl(fd, FS_IOC_GET_ENCRYPTION_POLICY_EX, buf, True)
    except OSError as err:
        if err.errno == errno.ENODATA:
            return None
        if err.errno in (errno.EOPNOTSUPP, errno.ENOTTY):
            raise Refusal(
                'encryption is not switched on for this file system: the one root step first '
                '(README.md, part H)'
            ) from err
        raise
    policy = bytes(buf[8:])
    if policy[0] != POLICY_V2:
        raise Refusal(f'the directory has an encryption policy of version {policy[0]}, not 2')
    return policy[8:24]


def set_policy(fd: int, identifier: bytes) -> None:
    """Encrypts the empty directory with the key of this identifier (added before)."""
    policy = struct.pack(
        '=BBBB4s16s',
        POLICY_V2,
        MODE_AES_256_XTS,
        MODE_AES_256_CTS,
        POLICY_FLAGS_PAD_32,
        bytes(4),
        identifier,
    )
    fcntl.ioctl(fd, FS_IOC_SET_ENCRYPTION_POLICY, policy)


def add_key(fd: int, key: bytearray) -> bytes:
    """Adds a key to the file system for this user; returns its identifier (from the kernel)."""
    header = struct.pack('=II32sI36s', KEY_SPEC_TYPE_IDENTIFIER, 0, bytes(32), len(key), bytes(36))
    buf = bytearray(header) + key
    try:
        fcntl.ioctl(fd, FS_IOC_ADD_ENCRYPTION_KEY, buf, True)
        return bytes(buf[8:24])
    finally:
        buf[:] = bytes(len(buf))


def remove_key(fd: int, identifier: bytes) -> int:
    """Removes this user's claim on the key; returns the kernel's removal flags."""
    buf = bytearray(_key_spec(identifier) + struct.pack('=I20s', 0, bytes(20)))
    fcntl.ioctl(fd, FS_IOC_REMOVE_ENCRYPTION_KEY, buf, True)
    return struct.unpack_from('=I', buf, KEY_SPEC_SIZE)[0]


def key_status(fd: int, identifier: bytes) -> int:
    """The key's status: 1 absent, 2 present, 3 removed but files still open."""
    buf = bytearray(_key_spec(identifier) + bytes(24) + bytes(64))
    fcntl.ioctl(fd, FS_IOC_GET_ENCRYPTION_KEY_STATUS, buf, True)
    return struct.unpack_from('=I', buf, 64)[0]


# ----------------------------------------------------------------------------------------- settings


def read_env(path: str) -> Dict[str, str]:
    """The install's settings, read as docker compose reads them (quotes, "export", comments)."""
    env = {}
    with open(path, encoding='utf8') as f:
        for raw in f:
            line = raw.rstrip('\r\n')
            if line.lstrip().startswith('export '):
                line = line.lstrip()[len('export '):]
            name, sep, value = line.partition('=')
            if not sep or not name.replace('_', '').isalnum():
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] in '\'"' and value.find(value[0], 1) > 0:
                value = value[1:value.find(value[0], 1)]
            else:
                value = value.split(' #')[0].strip()
            env[name] = value
    return env


class Install:
    """One install of deploy/docker-compose.yml: its settings and how to reach its OpenBao."""

    def __init__(self, env_file: str, project: str):
        self.env_file = env_file
        self.project = project
        env = read_env(env_file) if os.path.exists(env_file) else {}
        setting = env.get('OPENSEARCH_DATA_DIR', '')
        if not setting:
            raise Refusal(f'OPENSEARCH_DATA_DIR is not set in {env_file} (README.md, part H)')
        # relative to the compose file's folder, as docker compose reads a bind mount's path
        self.dir = os.path.abspath(os.path.join(DEPLOY, os.path.expanduser(setting)))
        self.wrapped_key_file = self.dir + '.wrapped-key'
        self.min_free_gb = int(env.get('OPENSEARCH_MIN_FREE_GB') or DEFAULT_MIN_FREE_GB)

    def ask_openbao(self, command: str, given: str = '') -> str:
        """Runs the one-shot service search-dir-key and returns what it printed (never logged)."""
        cmd = [
            'docker', 'compose', '--project-name', self.project, '--env-file', self.env_file,
            '-f', os.path.join(DEPLOY, 'docker-compose.yml'),
            'run', '--rm', '-T', '--no-deps', 'search-dir-key', command,
        ]
        res = subprocess.run(cmd, cwd=DEPLOY, input=given, capture_output=True, text=True)
        if res.returncode != 0:
            last = (res.stderr.strip().splitlines() or ['no answer'])[-1]
            raise Refusal(
                f'OpenBao did not give the key ({last[:200]}). Is OpenBao running and unsealed, '
                'and prepared with docker compose run --rm openbao-setup (README.md, part D)?'
            )
        return res.stdout.strip()


# ----------------------------------------------------------------------------------------- commands


def _open_dir(path: str) -> int:
    try:
        return os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    except OSError as err:
        raise Refusal(f'{path}: {err.strerror}') from err


def _read_wrapped_key(install: Install) -> str:
    try:
        with open(install.wrapped_key_file, encoding='utf8') as f:
            return f.read().strip()
    except OSError as err:
        raise Refusal(
            f'{install.wrapped_key_file}: {err.strerror} (restore it from the backup, part F)'
        ) from err


def create(install: Install) -> None:
    """Makes the empty directory, encrypts it with a new key and writes the marker inside."""
    path = install.dir
    if os.path.exists(install.wrapped_key_file):
        raise Refusal(
            f'{install.wrapped_key_file} exists already: the directory was created before'
        )
    os.makedirs(path, mode=0o700, exist_ok=True)
    if os.listdir(path):
        raise Refusal(f'{path} is not empty: only an empty directory can be encrypted')
    fd = _open_dir(path)
    try:
        if get_policy(fd) is not None:
            raise Refusal(f'{path} is encrypted already')
        answer = json.loads(install.ask_openbao('new'))['data']
        key = bytearray(base64.b64decode(answer['plaintext']))
        if len(key) != KEY_BYTES:
            raise Refusal(f'OpenBao gave a key of {len(key)} bytes, not {KEY_BYTES}')
        # the wrapped key first: without it the directory could never be opened again
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        with open(os.open(install.wrapped_key_file, flags, 0o600), 'w') as f:
            f.write(answer['ciphertext'] + '\n')
        identifier = None
        try:
            identifier = add_key(fd, key)
            set_policy(fd, identifier)
        except BaseException:
            os.remove(install.wrapped_key_file)
            if identifier is not None:
                remove_key(fd, identifier)
            raise
        finally:
            # best effort: Python keeps other copies (the answer's text) until they are freed
            key[:] = bytes(len(key))
    finally:
        os.close(fd)
    with open(os.path.join(path, MARKER), 'w', encoding='utf8') as f:
        f.write(MARKER_TEXT)
    print(f'Encrypted and unlocked: {path}')
    print(
        f'Its wrapped key: {install.wrapped_key_file} '
        '(back it up with the install; useless without OpenBao)'
    )


def unlock(install: Install) -> None:
    """Adds the directory's key, fetched from OpenBao, so that its files can be read."""
    path = install.dir
    fd = _open_dir(path)
    try:
        identifier = get_policy(fd)
        if identifier is None:
            raise Refusal(
                f'{path} is not encrypted: create it with this script (README.md, part H)'
            )
        if key_status(fd, identifier) == KEY_STATUS_PRESENT:
            print(f'Unlocked already: {path}')
            return
        wrapped = _read_wrapped_key(install)
        key = bytearray(base64.b64decode(install.ask_openbao('unwrap', wrapped)))
        try:
            added = add_key(fd, key)
        finally:
            key[:] = bytes(len(key))
        if added != identifier:
            remove_key(fd, added)
            raise Refusal(f'{install.wrapped_key_file} holds the key of another directory')
    finally:
        os.close(fd)
    if not os.path.exists(os.path.join(path, MARKER)):
        raise Refusal(f'{path} is unlocked but has no {MARKER}: the search engine will not start')
    print(f'Unlocked: {path}')


def lock(install: Install) -> None:
    """Removes the key: the files can no longer be read until the next unlock."""
    path = install.dir
    fd = _open_dir(path)
    try:
        identifier = get_policy(fd)
    finally:
        os.close(fd)
    if identifier is None:
        raise Refusal(f'{path} is not encrypted')
    # through the parent: an open directory would itself keep the key in use
    fd = _open_dir(os.path.dirname(path))
    try:
        if key_status(fd, identifier) not in (KEY_STATUS_PRESENT, KEY_STATUS_INCOMPLETELY_REMOVED):
            print(f'Locked already: {path}')
            return
        flags = remove_key(fd, identifier)
    finally:
        os.close(fd)
    if flags & REMOVAL_FLAG_FILES_BUSY:
        raise Refusal(
            'files in it are still open: stop the search engine first, then lock again '
            '(the files not open are locked)'
        )
    if flags & REMOVAL_FLAG_OTHER_USERS:
        raise Refusal('another user added the key too: it stays unlocked until they lock it')
    print(f'Locked: {path}')


def _size(path: str) -> int:
    """Bytes used on the disk by everything under path (readable when locked too)."""
    total = 0
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            try:
                total += os.lstat(os.path.join(root, name)).st_blocks * 512
            except OSError:
                pass
    return total


def status(install: Install) -> Dict[str, object]:
    """Where the directory stands: encrypted, unlocked, marker, free space, size."""
    path = install.dir
    answer = {
        'dir': path,
        'exists': os.path.isdir(path),
        'encrypted': False,
        'unlocked': False,
        'marker': False,
        'sizeBytes': None,
        'freeBytes': None,
        'minFreeBytes': install.min_free_gb * 10**9,
        'problem': None,
    }
    if not answer['exists']:
        answer['problem'] = 'does not exist'
        return answer
    try:
        fd = _open_dir(path)
        try:
            identifier = get_policy(fd)
            if identifier is not None:
                answer['encrypted'] = True
                answer['unlocked'] = key_status(fd, identifier) == KEY_STATUS_PRESENT
        finally:
            os.close(fd)
    except Refusal as err:
        answer['problem'] = str(err)
        return answer
    answer['marker'] = os.path.exists(os.path.join(path, MARKER))
    answer['sizeBytes'] = _size(path)
    answer['freeBytes'] = shutil.disk_usage(path).free
    return answer


def _gb(n: int) -> str:
    return f'{n / 10**9:.1f} GB'


def print_status(answer: Dict[str, object]) -> bool:
    """Prints the status for a person; True when the search engine may start on it."""
    ready = bool(answer['encrypted'] and answer['unlocked'] and answer['marker'])
    print(f"Directory: {answer['dir']}")
    if not answer['exists'] or answer['problem']:
        print(f"  {answer['problem']}")
        return False
    print(f"  encrypted: {'yes' if answer['encrypted'] else 'NO'}")
    print(f"  unlocked:  {'yes' if answer['unlocked'] else 'no'}")
    if answer['unlocked'] and not answer['marker']:
        print(f'  marker {MARKER} missing: the search engine will not start')
    print(f"  in use:    {_gb(answer['sizeBytes'])}")
    low = answer['freeBytes'] < answer['minFreeBytes']
    note = ' (below OPENSEARCH_MIN_FREE_GB)' if low else ''
    print(f"  free:      {_gb(answer['freeBytes'])}{note}")
    return ready


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description='The search engine\'s encrypted data directory (API-799).'
    )
    parser.add_argument(
        '--env', default=os.path.join(DEPLOY, '.env'), help='the install\'s settings'
    )
    parser.add_argument('--project', default='lrfe', help='its compose project')
    parser.add_argument('command', choices=['create', 'unlock', 'lock', 'status'])
    parser.add_argument('--json', action='store_true', help='status as JSON')
    args = parser.parse_args(argv)
    try:
        install = Install(os.path.abspath(args.env), args.project)
        if args.command == 'status':
            answer = status(install)
            if args.json:
                print(json.dumps(answer))
                return 0
            return 0 if print_status(answer) else 1
        {'create': create, 'unlock': unlock, 'lock': lock}[args.command](install)
        return 0
    except Refusal as err:
        if args.json:
            print(json.dumps({'problem': str(err)}))
            return 1
        print(f'Not done: {err}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
