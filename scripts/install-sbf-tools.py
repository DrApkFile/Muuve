"""Install pinned, checksum-verified SBF compiler under this checkout; no wallets."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import hashlib
import subprocess
import urllib.request

VERSION = 'v1.58'
SIZE = 531406444
SHA256 = '7b82eb420b5aebd1e5590db0ae25c523eca06724d4238ae02139690535636c37'
URL = f'https://github.com/anza-xyz/platform-tools/releases/download/{VERSION}/platform-tools-linux-x86_64.tar.bz2'
ROOT = Path(__file__).resolve().parent.parent
target = ROOT / '.cache' / f'platform-tools-{VERSION}'
marker = target / '.verified-sha256'
if marker.exists() and marker.read_text().strip() == SHA256:
    print(target)
    raise SystemExit(0)
parts = ROOT / '.cache' / 'sbf-download-parts'
parts.mkdir(parents=True, exist_ok=True)
chunk_size = 8 * 1024 * 1024

def download(i):
    start = i * chunk_size
    end = min(SIZE - 1, start + chunk_size - 1)
    path = parts / str(i)
    if path.exists() and path.stat().st_size == end - start + 1:
        return
    for attempt in range(4):
        try:
            request = urllib.request.Request(URL + f'?part={i}', headers={'Range': f'bytes={start}-{end}'})
            with urllib.request.urlopen(request, timeout=120) as response:
                if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{SIZE}':
                    raise RuntimeError('Unexpected compiler archive range')
                with path.open('wb') as output:
                    while data := response.read(256 * 1024):
                        output.write(data)
            if path.stat().st_size != end - start + 1:
                raise RuntimeError('Incomplete compiler download')
            return
        except Exception:
            if attempt == 3:
                raise RuntimeError('Compiler download failed; retry installation') from None

archive = ROOT / '.cache' / f'platform-tools-{VERSION}-verified.tar.bz2'
count = (SIZE + chunk_size - 1) // chunk_size
with ThreadPoolExecutor(max_workers=8) as executor:
    for future in as_completed([executor.submit(download, i) for i in range(count)]):
        future.result()
with archive.open('wb') as output:
    for i in range(count):
        with (parts / str(i)).open('rb') as part:
            while data := part.read(1024 * 1024):
                output.write(data)
with archive.open('rb') as data:
    if hashlib.file_digest(data, 'sha256').hexdigest() != SHA256:
        raise RuntimeError('Compiler archive checksum mismatch')
target.mkdir(parents=True, exist_ok=True)
subprocess.run(['tar', '-xjf', str(archive), '-C', str(target)], check=True)
marker.write_text(SHA256 + '\n')
print(target)
