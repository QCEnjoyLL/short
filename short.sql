CREATE TABLE IF NOT EXISTS links (
  `id` integer PRIMARY KEY NOT NULL,
  `url` text NOT NULL,
  `slug` text NOT NULL,
  `ua` text,
  `ip` text,
  `status` int NOT NULL DEFAULT 1,
  `create_time` DATE
);
CREATE TABLE IF NOT EXISTS logs (
  `id` integer PRIMARY KEY NOT NULL,
  `url` text ,
  `slug` text,
  `referer` text,
  `ua` text ,
  `ip` text ,
  `create_time` DATE
);

-- Existing duplicate slugs must be reviewed before creating the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS links_slug_unique ON links (slug);
CREATE INDEX IF NOT EXISTS links_url_index ON links (url);


