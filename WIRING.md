# Wiring the extension pack

Three edits. Nothing else changes.

## 1. `main.js` — require and call

Add near the top with your other requires:

```js
const { wireBrowserSidebar } = require('./src/main-integration');