import type { TestContext } from "node:test";

export function setEnvironment(t: TestContext, values: NodeJS.ProcessEnv): void {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (environment: NodeJS.ProcessEnv) => {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  t.after(() => apply(previous));
  apply(values);
}
