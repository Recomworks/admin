// Recomworks Admin — Outlook/Office 365 calendar feed
//
// This is a Supabase EDGE FUNCTION, not a file for the website itself.
// Deploy it via the Supabase Dashboard: Edge Functions -> Deploy a new function
// -> Via editor -> name it "ical-feed" -> paste this whole file in -> Deploy.
// Full walkthrough is in README.md.
//
// It reads your jobs (using the service-role key, bypassing the 2FA-only RLS
// rules, since Outlook can't complete a 2FA challenge) and outputs a standard
// .ics calendar feed that Outlook/Office 365 can subscribe to. Access is
// gated by a secret token in the URL (?key=...) rather than a login, the same
// way Google/Outlook's own "secret address" calendar links work.
//
// Required secrets (Edge Functions -> Secrets in the Supabase Dashboard):
//   SB_SERVICE_ROLE_KEY   -> Project Settings -> API -> "service_role" / "secret" key
//   ICS_FEED_TOKEN        -> any long random string you make up yourself
//                            (this becomes part of the feed URL — treat it like a password)

import { createClient } from "npm:@supabase/supabase-js@2";

function pad(n: number) { return String(n).padStart(2, "0"); }

function toICSDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
}

function escapeICS(s: string): string {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// RFC 5545 requires folding lines longer than 75 octets
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  var out = "";
  var rest = line;
  var first = true;
  while (rest.length > 0) {
    var chunk = first ? rest.slice(0, 75) : rest.slice(0, 74);
    out += (first ? "" : "\r\n ") + chunk;
    rest = rest.slice(chunk.length);
    first = false;
  }
  return out;
}

const STATUS_MAP: Record<string, string> = {
  unassigned: "TENTATIVE",
  assigned: "TENTATIVE",
  confirmed: "CONFIRMED",
  completed: "CONFIRMED",
  cancelled: "CANCELLED",
};

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const expected = Deno.env.get("ICS_FEED_TOKEN");

  if (!expected || key !== expected) {
    return new Response("Not authorized.", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SB_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response("Server not configured.", { status: 500 });
  }
  const sb = createClient(supabaseUrl, serviceKey);

  const { data: jobs, error } = await sb
    .from("jobs")
    .select("*, customers(company_name), job_engineers(engineers(name))")
    .order("start_at");

  if (error) {
    return new Response("Could not load jobs: " + error.message, { status: 500 });
  }

  const now = toICSDate(new Date().toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Recomworks//Admin Booking Diary//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Recomworks Bookings",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const job of jobs || []) {
    const customerName = job.customers?.company_name || "Unassigned customer";
    const engineerNames = (job.job_engineers || [])
      .map((je: any) => je.engineers?.name)
      .filter(Boolean)
      .join(", ") || "Unassigned";
    const start = job.start_at;
    const end = job.end_at || new Date(new Date(job.start_at).getTime() + 60 * 60 * 1000).toISOString();

    const descriptionParts = [
      "Service: " + (job.service_type || "-"),
      "Contractor(s): " + engineerNames,
      "Status: " + job.status,
    ];
    if (job.po_reference) descriptionParts.push("PO/reference: " + job.po_reference);
    if (job.notes) descriptionParts.push("Notes: " + job.notes);

    lines.push("BEGIN:VEVENT");
    lines.push(foldLine("UID:" + job.id + "@recomworks.co.uk"));
    lines.push("DTSTAMP:" + now);
    lines.push("DTSTART:" + toICSDate(start));
    lines.push("DTEND:" + toICSDate(end));
    lines.push(foldLine("SUMMARY:" + escapeICS((job.service_type || "Job") + " — " + customerName)));
    if (job.site_address) lines.push(foldLine("LOCATION:" + escapeICS(job.site_address)));
    lines.push(foldLine("DESCRIPTION:" + escapeICS(descriptionParts.join("\n"))));
    lines.push("STATUS:" + (STATUS_MAP[job.status] || "TENTATIVE"));
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": "inline; filename=recomworks-bookings.ics",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
