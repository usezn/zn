### Security
- `dotenv -e .env` makes `.env` a read only when the dotenv runner is the program itself or the program a launcher runs,
  and that launcher is itself the program (`npx`, `bunx`, `pnpx`, `pnpm dlx`, `pnpm exec`, `yarn dlx`, `npm exec`, `bun x`,
  optionally with `-y`, `--yes`, `-q` or `--quiet`). As an argument of another program (`node -e "..." dotenv -e .env` or
  `node -e "..." npx dotenv -e .env`) the name is judged like any other, so a program that can write it is refused.
