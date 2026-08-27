PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    bilibili_uid TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE progress (
    account_id TEXT NOT NULL,
    bvid TEXT NOT NULL,
    page INTEGER NOT NULL CHECK (page > 0),
    position REAL NOT NULL CHECK (position >= 0),
    duration REAL NOT NULL CHECK (duration >= 0),
    completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, bvid, page),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX progress_account_updated_idx ON progress(account_id, updated_at);
