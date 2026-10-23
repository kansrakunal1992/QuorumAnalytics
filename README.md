# Quorum usage dashboard

A private, read-only dashboard that shows how Quorum is being used. It runs as its own small service
(separate Railway project from the main app) and reads straight from your Supabase Postgres database.

One dependency (`pg`), no build step, no third-party scripts or fonts.

## What it shows

| Section | Answers |
|---|---|
| **Pulse** | Decisions, people deciding, new accounts, locked-decision rate, paid access, guest revenue, each against the previous period |
| **Where decisions stop** | For every chat started, the furthest point it reached (chat, confirm, prediction, quick check, synthesis, lock) |
| **Growth** | Daily decisions, people and signups; where signups came from; invites and referrals |
| **Day by day** | One row per day: decisions, people, new people, Council, locks, chats, landing views, accounts, sign-ins, guest orders and revenue, emails, AI calls. CSV download |
| **The front door** | Landing, start, sign-in, install, notification and Mirror events from the `events` table |
| **Coming back** | 2nd/3rd-decision rates, how soon the 2nd decision comes, DAU/WAU/MAU, weekly cohort retention, decisions per person |
| **Inside a session** | Council vs checkpoint, chat vs classic, which advisors speak, locks, commitments, outcomes, when people decide |
| **Features** | Who used watchlist, memory import, stakeholders, connectors, push, and so on |
| **Revenue** | Active paid access, estimated monthly recurring revenue, guest session payments |
| **Nudges and email** | Sent, opened, led to a decision; opt-out rates |
| **Platform and data health** | Model routing, institutions, and a list of any panel that could not load |

**Privacy.** Every query is an aggregate (counts and dates). The dashboard never selects decision text,
message content, notes or insight text, and does not list individual users. Every query also runs inside a
read-only transaction, so this app cannot change your data.

---

## Deploy on Railway

You need: a Railway account, your Supabase database password, and about ten minutes.

### 1. Get the database connection string from Supabase

1. Open your Supabase project and click **Connect** (top of the project page).
2. Copy the **Session pooler** connection string. Use this one, not "Direct connection": the direct host can be
   IPv6-only, which many hosting platforms cannot reach.
3. It contains `[YOUR-PASSWORD]`. Replace it with your **database password** (the one set when you created the
   project; reset it under Project Settings, then Database, if you have lost it). This is not an API key.
   If the password contains special characters, URL-encode them (`@` becomes `%40`, `#` becomes `%23`, `/` becomes `%2F`).

Supabase's labels move around from time to time; what you want is the `postgresql://postgres.<ref>:...@...pooler.supabase.com:5432/postgres` string.

### 2. Create the Railway project

**Option A: from GitHub (recommended, easiest to update later)**

1. Unzip this folder, create a new **private** GitHub repository, and push the contents to it.
   (`.gitignore` already keeps `node_modules` and `.env` out.)
2. In Railway: **New Project**, then **Deploy from GitHub repo**, and pick the repository.

**Option B: from your computer with the Railway CLI** (no GitHub needed)

```bash
npm i -g @railway/cli
railway login
cd quorum-dashboard
railway init        # create a new project
railway up          # upload and deploy this folder
```

### 3. Set the variables

In Railway, open the service, then the **Variables** tab, and add:

| Variable | Required | What to put |
|---|---|---|
| `DATABASE_URL` | **Yes** | The Supabase Session pooler string from step 1 |
| `DASHBOARD_PASSWORD` | **Yes** | A long password for the login page. Until it is set, the site shows a "setup needed" page and stays locked |
| `EXCLUDE_EMAILS` | Recommended | Your own email addresses, comma-separated. Your test activity (and the browsers you used) is removed from every number |
| `DASHBOARD_TZ` | No | Timezone for day boundaries. Default `Asia/Kolkata` |
| `PRICE_MONTHLY_INR` | No | Default `2999` |
| `PRICE_ANNUAL_INR` | No | Default `29999` |
| `PRICE_FOUNDING_MONTHLY_INR` | No | Default `999` |
| `PRICE_FOUNDING_ANNUAL_INR` | No | Default `9999` |
| `SESSION_SECRET` | No | Signs the login cookie. Defaults to a key derived from the password |
| `CACHE_TTL_SECONDS` | No | Default `60` (the Refresh button always bypasses it) |
| `PG_POOL_MAX` | No | Database connections, default `8` |
| `PG_CONNECT_TIMEOUT_MS` | No | How long a query may queue for a connection, default `45000` |

Do **not** set `PORT`; Railway provides it. You do **not** need any Supabase API keys or the service-role key.

The price defaults are taken from the pricing comment in the main app's payment webhook. They only affect the
"estimated monthly recurring revenue" figure, so please confirm them against your live plans.

### 4. Open it

In the service, go to **Settings, then Networking, then Generate Domain**. Open that URL and sign in with
`DASHBOARD_PASSWORD`. Railway redeploys automatically whenever you change a variable.

Health check: `/healthz` (no login, does not touch the database).

**Speed tip.** The page runs about fifty queries. If it feels slow, set the Railway service region to the one closest to your Supabase project (service Settings, then Deploy, then Region; your Supabase region is under Project Settings, General). Network distance is the main cost.

---

## Optional hardening: a read-only database login

By default you connect as `postgres`, which can read everything. For a least-privilege setup, run
`sql/create_readonly_role.sql` in the Supabase SQL Editor (change the password inside first). It creates
`dashboard_ro`, which can read only the handful of columns the dashboard uses and cannot read decision text,
messages or notes at all. Then use that login in `DATABASE_URL`; on the Supabase pooler the user name must be
`dashboard_ro.<your-project-ref>`.

Notes: this was tested on plain Postgres, not on Supabase itself. If Supabase refuses the `auth.users` grant, the
signup panels will show an error and you can keep using `postgres`. The Institutions panel can also error under
this login because of a recursive row-level-security policy among the institutional tables. If a login is being
filtered by row-level security, the dashboard says so under "Data quality" rather than quietly showing zeros.

---

## Reading the numbers

- **Days** follow `DASHBOARD_TZ`. "Last 30 days" means today plus the 29 days before it, and the comparison is the 30 days before that. Use **Custom** for any range up to 366 days ending today or earlier; the comparison is then the same number of days immediately before it. DAU/WAU/MAU always mean "as of now".
- **A person** is a signed-in user, or a browser (device id) if they never signed in. Someone who decided anonymously
  and later signed in on the same browser counts once. Decisions with no device id and no account (visitors who
  declined functional cookies) count as decisions but cannot be counted as people; Data quality shows how many.
- **Events** only exist from the day event tracking shipped, so early windows in the front-door section look small.
  Landing "people" is an undercount for the same cookie-consent reason.
- **Where decisions stop** counts chat intakes only. Classic-mode sessions never pass through the chat, so they appear in decision totals but not there.
- **Retention** is over all time. "Mature" restricts to people whose first decision is old enough for the question to be fair.
- **Paid access** counts monthly and annual rows until they expire (including the 3-day grace buffer; cancelled plans count until expiry).
  Monthly recurring revenue is an estimate from the prices above. New paid conversions come from events, because renewals reset the grant date.
- **Test accounts** in `EXCLUDE_EMAILS` are removed from sessions, chats, events, signups, feature use, preferences and paid-access rows. Guest session payments have no account attached, so they cannot be filtered.

## Troubleshooting

| What you see | Likely cause |
|---|---|
| A panel says "timeout exceeded" | The database was slow for that query. Press Refresh; if it keeps happening, move the Railway service to the same region as Supabase |
| "Could not load the numbers" | `DATABASE_URL` is wrong, or the password has unescaped special characters. Check the Railway deploy logs |
| A panel shows "unavailable: relation ... does not exist" | That migration has not been run in this database. Only that panel is affected |
| Everything reads zero | The login is filtered by row-level security (see Data quality), or the project is brand new |
| "None of the addresses in EXCLUDE_EMAILS matched" | Typo in the variable, or that address has never signed in |
| "Setup needed" page | `DASHBOARD_PASSWORD` is not set |
| Locked out after wrong passwords | Five wrong attempts from one IP lock it for 15 minutes |

## Run it locally

```bash
cp .env.example .env     # fill in DATABASE_URL and DASHBOARD_PASSWORD
npm install
npm run dev              # http://localhost:3000
```

## Files

```
server.js            web server, login, API
lib/db.js            read-only, time-limited database access
lib/metrics.js       every query (one per panel, each isolated)
public/              the page (index.html, login.html, assets/)
sql/create_readonly_role.sql   optional least-privilege login
railway.toml         start command and health check
```
