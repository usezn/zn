### Security
- `dotenv -e .env` makes `.env` a read only when the dotenv runner is the program itself or the program a launcher runs
  (`npx`, `bunx`, `pnpx`, `pnpm dlx`, `yarn dlx`, `npm exec`). As an argument of another program
  (`node -e "..." dotenv -e .env`) the name is judged like any other, so a program that can write it is refused.
