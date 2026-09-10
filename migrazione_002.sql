-- =====================================================================
-- Migrazione 2 — 10/09/2026
-- Accessi falliti per blocco temporaneo; i token di sessione e monouso
-- si conservano come SHA-256 (le colonne `token` restano, cambia il
-- contenuto: nessuna riga precedente da convertire, le tabelle erano vuote).
-- =====================================================================

CREATE TABLE IF NOT EXISTS accessi_falliti (
  email   TEXT PRIMARY KEY COLLATE NOCASE,
  n       INTEGER NOT NULL,
  ultimo  INTEGER NOT NULL
);

INSERT OR IGNORE INTO migrazioni (versione, applicata, nota)
VALUES (2, strftime('%s','now'), 'accessi_falliti, token di sessione e monouso conservati come SHA-256');
