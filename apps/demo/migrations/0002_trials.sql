-- Requests for a trial licence key of the SDK, from /sdk. Kept to send the key and follow up.
CREATE TABLE trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  domains TEXT NOT NULL,
  message TEXT
);
