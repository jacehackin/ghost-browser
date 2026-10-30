# Wiring the v2 upgrade

The v2 pack replaces `main-integration.js` with a richer version that adds body
rewriting, HAR export, and per-tab proxy routing. Base browser + v1 pack stay
untouched structurally — you're swapping one module and adding four new files.

## 1. New files to place