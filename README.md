# Recomworks Admin System

A private booking diary / admin tool for Recomworks Ltd: customer records, contractor
records, and a calendar of booked-in jobs with contractor assignment and one-click
"email the contractor" job sheets.

It's a static front-end (plain HTML/CSS/JS, no build step — same style as the main
website) backed by a free **Supabase** project, which gives you a real Postgres
database plus password + 2FA (TOTP authenticator app) login, completely separate
from the main recomworks.co.uk site and from solnx.

Nothing in this repo is secret. The Supabase "anon" key in `js/config.js` is
designed to be public — on its own it grants no access. Every table requires a
real signed-in session that has also completed a 2FA challenge (enforced at the
database level, not just in the page), so even a leaked/copied key can't be used
to read or write your data.

## 1. Create a free Supabase project

1. Go to **supabase.com** → Start your project → sign up (free tier is plenty for this).
2. Create a new project. Pick any name (e.g. "recomworks-admin") and a strong
   database password (store it somewhere safe — you likely won't need it day to day).
3. Wait a minute or two for it to finish provisioning.

## 2. Create the database tables

1. In your new project, open the **SQL Editor** (left sidebar).
2. Click **New query**, paste in the entire contents of `supabase-schema.sql`
   (in this folder), and click **Run**.
3. This creates the `customers`, `engineers`, `jobs` and `job_engineers` tables,
   and locks every one of them down so only a fully signed-in (2FA-verified)
   session can read or write anything.

## 3. Lock down sign-ups & switch on 2FA

1. Go to **Authentication → Providers** and make sure **Email** is enabled
   (it is by default).
2. Go to **Authentication → Settings** (sometimes called "Sign In / Providers"
   → General) and turn **OFF** "Allow new users to sign up". This is important —
   without it, anyone who found your site could create their own account.
   Staff accounts get added by you manually (next step) instead.
3. Go to **Authentication → Multi-Factor** (or "MFA") and confirm **TOTP** is
   enabled — it is on by default on new projects.

## 4. Create your own staff login

1. Go to **Authentication → Users → Add user → Create new user**.
2. Enter your email (e.g. `hello@recomworks.co.uk`) and set a password.
3. Tick **Auto Confirm User** so you don't need to click an email link.
4. Repeat for any other staff who need access.

The first time each person signs in on the site, they'll be walked through
scanning a QR code with an authenticator app (Google Authenticator, Authy,
1Password, etc.) — this is mandatory before the tool lets them see any data.

## 5. Connect the site to your database

1. In Supabase, go to **Project Settings → API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `js/config.js` in this folder and paste them in:
   ```js
   window.RECOMWORKS_CONFIG = {
     SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
     SUPABASE_ANON_KEY: 'eyJ...'
   };
   ```

## 6. Put it on GitHub Pages at admin.recomworks.co.uk

This needs its **own repository** (separate from the `website` repo), because a
GitHub Pages site can only have one custom domain each.

1. On the same `Recomworks` GitHub account, create a new repository — e.g. **admin**.
   Keep it Public (GitHub Pages needs that on the free plan) — remember, the
   database itself is what's actually protected, not the repo.
2. Upload every file and folder from this `recomworks-admin` folder into the repo
   root, preserving the `css/`, `js/` and `assets/` subfolders (drag the folders
   themselves into GitHub's uploader, the same way we fixed this on the main site).
3. Go to **Settings → Pages**. Under Source, choose **Deploy from a branch**,
   branch `main`, folder `/ (root)`, Save.
4. Under **Custom domain**, enter `admin.recomworks.co.uk` and Save.
5. In your DNS provider (Cloudflare), add:

   | Type | Name | Content | Proxy status |
   |---|---|---|---|
   | CNAME | admin | recomworks.github.io | DNS only |

6. Wait for the "DNS check successful" tick on the Pages settings page, then
   tick **Enforce HTTPS** once it becomes available (same process as the main
   site — can take a few minutes to a couple of hours).

## 7. Sync the diary to Outlook / Office 365 (one-way)

Jobs booked in the admin tool can show up automatically in your Outlook/O365
calendar (and your phone, if it's connected to the same account) as a
**subscribed calendar feed** — you keep creating and editing jobs in the admin
tool, and Outlook just displays a live read-only copy. Outlook refreshes
subscribed feeds itself on its own schedule (typically every few hours, up to
about 24 hours) — that timing is set by Microsoft, not something we can
speed up from this end.

1. In Supabase, go to **Edge Functions → Deploy a new function → Via editor**,
   name it exactly `ical-feed`, delete the placeholder code, and paste in the
   entire contents of `edge-function-ical-feed.ts` (in this folder). Click
   **Deploy function**.
2. Go to **Edge Functions → Secrets** and add two secrets:
   - `SB_SERVICE_ROLE_KEY` — paste in the **service_role** (sometimes labelled
     **secret**) key from Project Settings → API. This is different from the
     anon key — keep it out of GitHub entirely, it only goes here.
   - `ICS_FEED_TOKEN` — make up a long random string yourself (e.g. mash the
     keyboard for 30+ characters). This becomes part of your calendar link, so
     treat it like a password — anyone with the full link can see your job
     list.
3. Your feed URL is:
   `https://YOUR_PROJECT_REF.supabase.co/functions/v1/ical-feed?key=YOUR_ICS_FEED_TOKEN`
   (find `YOUR_PROJECT_REF` in the Project URL from step 5 above).
4. In Outlook / Office 365 (outlook.office.com): **Add calendar → Subscribe
   from web**, paste that URL in, give it a name like "Recomworks Bookings",
   and save. On desktop Outlook: **Add Calendar → From Internet**, same URL.

If you ever need to revoke access (e.g. the link leaked), just change
`ICS_FEED_TOKEN` in Supabase to a new value and re-subscribe with the new URL.

## Using it day to day

- **Calendar** — month view of booked jobs; click a day to see/add jobs for that day.
- **Jobs** — flat list of every job, with an "Email contractor" button that opens
  your email app with the job details pre-filled to whoever's assigned.
- **Customers** / **Contractors** — simple record-keeping, searchable.

## Adding more staff later

Repeat step 4 in Supabase (Authentication → Users → Add user) — no code changes
needed. They'll set up their own 2FA on first sign-in.
