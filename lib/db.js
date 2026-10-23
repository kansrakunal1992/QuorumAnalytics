'use strict'
// lib/db.js
// Postgres access for the dashboard.
//
// Read-only by construction: the first thing each new connection does is
//   SET default_transaction_read_only = on   (every write fails)
//   SET statement_timeout = '25s'            (no runaway query)
// This is applied ONCE per connection, so each query costs a single network round
// trip. (An earlier version wrapped every query in BEGIN/SET/COMMIT = 4 round trips,
// which made the page slow when the database is far from Railway.)
//
// Use Supabase's SESSION pooler (port 5432), where per-connection settings stick.
// For belt and braces, sql/create_readonly_role.sql creates a login that is
// read-only at the role level.

const { Pool } = require('pg')

let pool = null
const configured = new WeakSet()

function getPool() {
  if (pool) return pool
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')

  // Supabase requires TLS. Its pooler certificate chain is not in Node's default
  // trust store, so we encrypt without verifying the chain (standard for Supabase
  // + node-pg). Set PGSSL=disable only for a local, non-TLS Postgres.
  const ssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }

  pool = new Pool({
    connectionString: url,
    ssl,
    max: Number(process.env.PG_POOL_MAX || 8),
    idleTimeoutMillis: 30_000,
    // how long a query may WAIT for a free connection (the page runs ~50 queries at once)
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 45_000),
  })
  // A dropped idle connection must not crash the process.
  pool.on('error', err => console.warn('[db] idle client error:', err.message))
  return pool
}

const STATEMENT_TIMEOUT = process.env.STATEMENT_TIMEOUT || '25s'
const SETUP = `SET default_transaction_read_only = on; SET statement_timeout = '${STATEMENT_TIMEOUT}'`

/** Run one read-only query. Returns rows. Throws on SQL error (callers isolate per panel). */
async function q(sql, params = []) {
  const client = await getPool().connect()
  try {
    if (!configured.has(client)) {
      await client.query(SETUP) // one round trip, once per connection
      configured.add(client)
    }
    return (await client.query(sql, params)).rows
  } finally {
    client.release()
  }
}

module.exports = { q, getPool }
