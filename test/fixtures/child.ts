import { HrImporter } from "../../src/index.js";

function hang(): never {
  console.log("PAUSED");
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0);
  throw new Error("unreachable");
}

function main(): void {
  const [, , dbPath, csvPath, mode, advancesArg] = process.argv;
  const normalAdvances = Number(advancesArg ?? "0");
  let armed = false;

  const importer = new HrImporter(dbPath, {
    hooks: {
      beforeCommit: () => {
        if (armed && mode === "hang-before-commit") hang();
      },
      afterCommit: () => {
        if (armed && mode === "hang-after-commit") hang();
      },
    },
  });

  const id = importer.createImport(csvPath);
  console.log(`TASK:${id}`);
  for (let i = 0; i < normalAdvances; i++) {
    const r = importer.advanceImport(id);
    console.log(`ADV:${JSON.stringify(r)}`);
  }
  if (mode === "hang-before-commit" || mode === "hang-after-commit") {
    armed = true;
    importer.advanceImport(id);
    console.log("RETURNED");
  }
  importer.close();
}

main();
