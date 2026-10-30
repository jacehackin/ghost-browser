{
  "id": "strip-referer-example",
  "enabled": true,
  "match": "^https?://api\\.example\\.com/",
  "phase": "request",
  "set": {},
  "remove": ["Referer", "Origin"]
}