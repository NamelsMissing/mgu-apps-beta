'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const get = p => fs.readFileSync(path.join(root,p),'utf8');
const app = JSON.parse(get('apps/blitzer_status/app.json'));
const tool = JSON.parse(get('native/cluster-net/component.json'));
const cat = JSON.parse(get('mgu-repo.json')).components;
const b = cat.find(x=>x.id === app.id), n = cat.find(x=>x.id === tool.id);
assert.ok(b && n, 'app and helper listed in beta catalog');
assert.equal(b.version, app.version);
assert.equal(n.version, tool.version);
assert.equal(b.requires[tool.id], tool.version);
assert.equal(b.requires['cluster-render'], '0.4.0');
assert.equal(app.mguAppStartType, 'autostart');
assert.ok(/AUTOSTART_APPS = \\([^)]*"blitzer_status"/.test(get('tools/build_wheelheat_autostart.py')));
for(const key of ['phoneBridge','phoneBadge']) {
    assert.equal(app.settings.find(x=>x.key===key).default,false);
}
for(const file of tool.files) assert.ok(fs.existsSync(path.join(root,'native/cluster-net',file.path)));
assert.ok(fs.existsSync(path.join(root,'apps/blitzer_status/background_status.js')));
console.log('ok: Blitzer beta catalog, version, autostart, safe defaults, helper');
