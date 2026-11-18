### Security

- The hooks protect the `.zn` folder and the agent plugin folders of the operating-system account's own home, the folder the hook settings are read from, even when `HOME` or `USERPROFILE` names another folder (containers, CI jobs, a project's agent environment). Before, only the folder `HOME` named was protected in that case, so an agent could edit the settings that turn checks off.
