const initSqlJs = require("./node_modules/sql.js");
const fs = require("fs");
const path = require("path");
async function main() {
  const SQL = await initSqlJs.default();
  const dbPath = path.join(
    process.env.APPDATA,
    "Code", "User", "globalStorage", "state.vscdb"
  );
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = 'activeProfile'");
  if (stmt.step()) {
    console.log("activeProfile:", stmt.getAsObject().value);
  } else {
    console.log("no activeProfile key found");
  }
  const keys = db.prepare("SELECT key FROM ItemTable WHERE key LIKE '%profile%'").all();
  console.log("profile related keys:");
  keys.forEach(k => console.log("  " + k.key));
  db.close();
}
main().catch(console.error);
