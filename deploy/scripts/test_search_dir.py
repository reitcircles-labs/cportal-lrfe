"""Tests of search_dir.py (API-799) with a stand-in for the kernel and OpenBao.

  python3 -m unittest discover -s deploy/scripts -p 'test_*.py'

The real kernel interface is tried on the server itself (deploy/README.md, part H).
"""

import base64
import contextlib
import errno
import io
import json
import os
import struct
import tempfile
import unittest
from unittest import mock

import search_dir

KEY = bytes(range(64))
IDENTIFIER = bytes(range(100, 116))
WRAPPED = 'vault:v1:wrapped-key'


class FakeKernel:
    """The fscrypt ioctls on directories, as the kernel answers them for one user."""

    def __init__(self, supported=True):
        self.supported = supported
        self.policies = {}  # inode -> identifier
        self.keys = set()  # identifiers added
        self.half_removed = set()  # removed while files were open
        self.busy = False

    def ioctl(self, fd, request, buf, mutate=True):
        inode = os.fstat(fd).st_ino
        if not self.supported:
            raise OSError(errno.EOPNOTSUPP, 'not supported')
        if request == search_dir.FS_IOC_GET_ENCRYPTION_POLICY_EX:
            if inode not in self.policies:
                raise OSError(errno.ENODATA, 'no policy')
            buf[8:] = struct.pack('=BBBB4s16s', 2, 1, 4, 3, bytes(4), self.policies[inode])
        elif request == search_dir.FS_IOC_SET_ENCRYPTION_POLICY:
            identifier = bytes(buf[8:24])
            if identifier not in self.keys:
                raise OSError(errno.ENOKEY, 'key not added')
            self.policies[inode] = identifier
        elif request == search_dir.FS_IOC_ADD_ENCRYPTION_KEY:
            size = struct.unpack_from('=I', buf, 40)[0]
            raw = bytes(buf[80:80 + size])
            identifier = IDENTIFIER if raw == KEY else bytes(16)
            self.keys.add(identifier)
            buf[8:24] = identifier
        elif request == search_dir.FS_IOC_GET_ENCRYPTION_KEY_STATUS:
            identifier = bytes(buf[8:24])
            status = 2 if identifier in self.keys else 3 if identifier in self.half_removed else 1
            struct.pack_into('=I', buf, 64, status)
        elif request == search_dir.FS_IOC_REMOVE_ENCRYPTION_KEY:
            identifier = bytes(buf[8:24])
            self.keys.discard(identifier)
            self.half_removed.discard(identifier)
            if self.busy:
                self.half_removed.add(identifier)
            struct.pack_into('=I', buf, 40, search_dir.REMOVAL_FLAG_FILES_BUSY if self.busy else 0)
        else:
            raise OSError(errno.ENOTTY, 'unknown')
        return 0


class SearchDirTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, 'data', 'opensearch')
        self.env = os.path.join(self.tmp.name, '.env')
        with open(self.env, 'w') as f:
            f.write(f'OPENSEARCH_DATA_DIR={self.dir}\nOPENSEARCH_MIN_FREE_GB=1\n')
        self.kernel = FakeKernel()
        patcher = mock.patch.object(search_dir.fcntl, 'ioctl', self.kernel.ioctl)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.asked = []
        patcher = mock.patch.object(search_dir.Install, 'ask_openbao', self.openbao)
        patcher.start()
        self.addCleanup(patcher.stop)

    def openbao(self, command, given=''):
        self.asked.append(command)
        if command == 'new':
            plaintext = base64.b64encode(KEY).decode()
            return json.dumps({'data': {'plaintext': plaintext, 'ciphertext': WRAPPED}})
        self.assertEqual(given, WRAPPED)
        return base64.b64encode(KEY).decode()

    def run_script(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = search_dir.main(['--env', self.env, *args])
        return code, out.getvalue(), err.getvalue()

    def status(self):
        code, out, _ = self.run_script('status', '--json')
        self.assertEqual(code, 0)
        return json.loads(out)

    def test_create_encrypts_unlocks_and_keeps_only_the_wrapped_key(self):
        code, out, _ = self.run_script('create')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.asked, ['new'])
        with open(self.dir + '.wrapped-key') as f:
            self.assertEqual(f.read().strip(), WRAPPED)
        self.assertEqual(os.stat(self.dir + '.wrapped-key').st_mode & 0o777, 0o600)
        answer = self.status()
        self.assertTrue(answer['encrypted'] and answer['unlocked'] and answer['marker'])
        self.assertNotIn(base64.b64encode(KEY).decode(), out)

    def test_create_refuses_a_directory_that_is_not_empty(self):
        os.makedirs(self.dir)
        open(os.path.join(self.dir, 'old'), 'w').close()
        code, _, err = self.run_script('create')
        self.assertEqual(code, 1)
        self.assertIn('not empty', err)
        self.assertEqual(self.asked, [])

    def test_create_explains_the_root_step_when_the_file_system_has_no_encryption(self):
        self.kernel.supported = False
        code, _, err = self.run_script('create')
        self.assertEqual(code, 1)
        self.assertIn('one root step', err)
        self.assertFalse(os.path.exists(self.dir + '.wrapped-key'))

    def test_lock_then_unlock_fetches_the_key_from_openbao(self):
        self.run_script('create')
        self.assertEqual(self.run_script('lock')[0], 0)
        self.assertFalse(self.status()['unlocked'])
        code, out, _ = self.run_script('unlock')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.asked, ['new', 'unwrap'])
        self.assertTrue(self.status()['unlocked'])

    def test_unlock_twice_asks_openbao_once(self):
        self.run_script('create')
        code, out, _ = self.run_script('unlock')
        self.assertEqual(code, 0)
        self.assertIn('already', out)
        self.assertEqual(self.asked, ['new'])

    def test_unlock_refuses_a_plain_directory(self):
        os.makedirs(self.dir)
        code, _, err = self.run_script('unlock')
        self.assertEqual(code, 1)
        self.assertIn('not encrypted', err)

    def test_unlock_refuses_the_key_of_another_directory(self):
        self.run_script('create')
        self.run_script('lock')
        other_key = base64.b64encode(bytes(64)).decode()
        with mock.patch.object(search_dir.Install, 'ask_openbao', return_value=other_key):
            code, _, err = self.run_script('unlock')
        self.assertEqual(code, 1)
        self.assertIn('another directory', err)
        self.assertEqual(self.kernel.keys, set())

    def test_lock_while_files_are_open_says_to_stop_the_search_engine_then_finishes(self):
        self.run_script('create')
        self.kernel.busy = True
        code, _, err = self.run_script('lock')
        self.assertEqual(code, 1)
        self.assertIn('stop the search engine', err)
        self.kernel.busy = False
        code, out, _ = self.run_script('lock')
        self.assertEqual(code, 0)
        self.assertIn('Locked:', out)
        self.assertEqual(self.kernel.half_removed, set())

    def test_status_reports_free_space_against_the_setting(self):
        self.run_script('create')
        answer = self.status()
        self.assertEqual(answer['minFreeBytes'], 10**9)
        self.assertGreater(answer['freeBytes'], 0)
        self.assertGreater(answer['sizeBytes'], 0)

    def test_status_of_a_missing_directory(self):
        answer = self.status()
        self.assertFalse(answer['exists'])
        self.assertEqual(answer['problem'], 'does not exist')

    def test_a_missing_setting_is_reported(self):
        with open(self.env, 'w') as f:
            f.write('# nothing\n')
        code, out, _ = self.run_script('status', '--json')
        self.assertEqual(code, 1)
        self.assertIn('OPENSEARCH_DATA_DIR is not set', json.loads(out)['problem'])


class ReadEnvTest(unittest.TestCase):

    def test_reads_settings_as_docker_compose_does(self):
        with tempfile.NamedTemporaryFile('w', suffix='.env', delete=False) as f:
            f.write('export A=1\nB="two words" # note\nC=three # note\n# D=4\nE=\n')
        self.addCleanup(os.remove, f.name)
        self.assertEqual(
            search_dir.read_env(f.name), {'A': '1', 'B': 'two words', 'C': 'three', 'E': ''}
        )


if __name__ == '__main__':
    unittest.main()
