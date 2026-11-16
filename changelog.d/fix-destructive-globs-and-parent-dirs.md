### Security
- Both packages: the destructive-command check (`checkCommand()` / `check_command()` and the opt-in agent hook rules)
  now reads a glob (`*`, `?`, `[...]`) that can match a protected folder, block device or program as that folder,
  device or program: `rm -rf /us?`, `rm -rf /h*`, `chmod -R 777 /e[t]c`, `dd of=/dev/sd?`, `/usr/bin/r? -rf /home/alice`
  and `/usr/bin/c[h]mod -R 777 /` are blocked. A glob that cannot match any of them stays allowed
  (`rm -rf ./build/*`, `rm -rf /home/alice/proj/*.o`, `rm -rf /tmp/*`).
- Both packages: a path that climbs out of the home folder with `..` is now read on from the folder that holds it
  instead of stopping there, so `rm -rf ~/../alice/proj/build` and `chmod -R 777 ~/../alice/proj/build` (a project
  folder of another user) are no longer blocked. `~/..`, `~/../..`, `~/../alice` and `~/../../etc` stay blocked.
