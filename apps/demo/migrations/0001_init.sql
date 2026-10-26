-- Anonymous usage: how many times a day something was used. No user, IP or file data.
CREATE TABLE counts (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);

-- Errors the site ran into, counted per day and message.
CREATE TABLE errors (
  day TEXT NOT NULL,
  message TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, message)
);

-- What people wrote in the feedback form.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  message TEXT NOT NULL,
  email TEXT,
  browser TEXT
);
