# NovaSphere Evacuation Planner

In-memory host maintenance evacuation planning library for NovaSphere.
It only plans — it never controls VMs. Input and results live in process
memory only.

## Usage

```ts
import { planEvacuation } from "novasphere-evacuation-planner";

const result = planEvacuation({
  hosts: [
    { id: "M", arch: "x86", cpuBudget: 8, memBudget: 1024 },
    { id: "A", arch: "x86", cpuBudget: 8, memBudget: 1024 },
  ],
  vms: [{ id: "vm-1", arch: "x86", cpu: 2, mem: 128 }],
  placement: { "vm-1": "M" },
  maintenanceHostId: "M",
});

if (result.ok) {
  // result.plan.migrations: ordered, individually executable steps
} else {
  // proven: no live-migration sequence can evacuate the host
}
```

## Model

- Migrations are strictly sequential. The target host must hold the whole
  VM (cpu + memory) before the migration starts; the source releases its
  resources only after completion. No swaps, no partial moves.
- The maintenance host accepts no inbound migrations from the start.
- VMs only run on hosts of the same architecture (`x86` / `arm`).
- Other VMs may be moved (even multiple times) to free up resources.
- Optimality: fewest migrations, then least total migrated memory (MiB,
  accumulated per migration of the same VM).
- `ok: false` is returned only after the full reachable state space is
  exhausted — never on heuristic failure.

## Develop

```sh
npm install
npm test
```
