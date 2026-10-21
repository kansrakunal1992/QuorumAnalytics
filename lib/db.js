'use strict'
// lib/db.js
// Postgres access for the dashboard.
//
// Every query runs inside BEGIN READ ONLY with a statement timeout, so even a
// bug in this codebase (or a leaked DATABASE_URL pointed at a powerful role)
// cannot be used through this process to modify data.

const { Pool } = require('pg')

let pool = null

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
    max: Number(process.env.PG_POOL_MAX || 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
  // A dropped idle connection must not crash the process.
  pool.on('error', err => console.warn('[db] idle client error:', err.message))
  return pool
}

const STATEMENT_TIMEOUT = process.env.STATEMENT_TIMEOUT || '20s'

/** Run one read-only query. Returns rows. Throws on SQL error (caller isolates). */
async function q(sql, params = []) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
    const res = await client.query(sql, params)
    await client.query('COMMIT')
    return res.rows
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* connection may be gone */ }
    throw err
  } finally {
    client.release()
  }
}

module.exports = { q, getPool }
