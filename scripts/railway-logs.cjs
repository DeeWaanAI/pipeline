// READ-ONLY: fetch the deewaanai deployment logs, filtered, to surface the
// server-side "Backup: run failed" error detail. Resolves the deploymentLogs
// return type (scalar vs object) automatically. Never prints secrets.
const fs = require("fs");
const os = require("os");
const path = require("path");
const TOKEN = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".railway", "config.json"), "utf8")).token;
const API = "https://backboard.railway.app/graphql/v2";
const PROJECT = "a8f648e3-08d1-4c4f-bd72-ae32a3d002e6";
const ENVID = "0e0f63af-749c-4976-bb13-3a148936f683";
const SERVICE = "0df3caa3-1b65-4b20-8774-fd62de16e70a";
const FILTER = process.argv[2] || "Backup";

async function gql(query, variables) {
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ query, variables }) });
  return r.json();
}
function resolve(t) { let list = false, cur = t; while (cur) { if (cur.kind === "LIST") { list = true; cur = cur.ofType; } else if (cur.kind === "NON_NULL") cur = cur.ofType; else break; } return { name: cur?.name, kind: cur?.kind, list }; }

(async () => {
  const dep = await gql(`query($input:DeploymentListInput!){ deployments(input:$input,first:1){ edges{ node{ id status createdAt } } } }`, { input: { projectId: PROJECT, environmentId: ENVID, serviceId: SERVICE } });
  const d = dep.data.deployments.edges[0].node;
  console.log(`deployment ${d.id} ${d.status} ${d.createdAt}`);

  // Resolve deploymentLogs element type
  const sch = await gql(`{ __schema { queryType { fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }`);
  const f = sch.data.__schema.queryType.fields.find(x => x.name === "deploymentLogs");
  const rt = resolve(f.type);
  console.log(`deploymentLogs element: ${rt.name} (${rt.kind}) list=${rt.list}`);

  let selection = "";
  if (rt.name === "Log") {
    selection = "{ message severity timestamp attributes { key value } }";
    console.log("selection: message severity timestamp attributes{key value}");
  } else if (rt.kind === "OBJECT" || rt.kind === "INTERFACE" || rt.kind === "UNION") {
    const tt = await gql(`query($n:String!){ __type(name:$n){ fields{ name type{ kind ofType{ kind } } } } }`, { n: rt.name });
    const isScalar = (ty) => ty.kind === "SCALAR" || ty.kind === "ENUM" || (ty.kind === "NON_NULL" && ty.ofType && (ty.ofType.kind === "SCALAR" || ty.ofType.kind === "ENUM"));
    const names = (tt.data.__type?.fields || []).filter(x => isScalar(x.type)).map(x => x.name);
    selection = "{ " + names.join(" ") + " }";
    console.log("scalar fields:", names.join(", "));
  }

  const q = `query($id:String!,$filter:String,$limit:Int){ deploymentLogs(deploymentId:$id, filter:$filter, limit:$limit) ${selection} }`;
  const res = await gql(q, { id: d.id, filter: FILTER, limit: 200 });
  if (res.errors) { console.log("LOG QUERY ERROR:", JSON.stringify(res.errors).slice(0, 400)); return; }
  const lines = res.data.deploymentLogs || [];
  console.log(`--- ${lines.length} log lines matching "${FILTER}" ---`);
  for (const ln of lines) {
    const s = typeof ln === "string" ? ln : JSON.stringify(ln);
    console.log(s.slice(0, 600));
  }
})();
