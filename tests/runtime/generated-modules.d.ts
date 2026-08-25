declare module '*.mjs' {
  const migrations: { name: string; queries: string[] }[];
  export default migrations;
}
