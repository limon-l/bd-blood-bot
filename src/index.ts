import { Bot, webhookCallback, InlineKeyboard, Keyboard } from "grammy";
import { createClient } from "@supabase/supabase-js";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    
    const PHONE_REGEX = /^(\+880|0)1[3-9]\d{8}$/;

    function escapeHtml(text: string = ""): string {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function chunkArray<T>(array: T[], size: number): T[][] {
      const chunks: T[][] = [];
      for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
      }
      return chunks;
    }

    // ==========================================
    // CORE SYSTEM
    // ==========================================
    async function getSession(chatId: number) {
      const { data, error } = await supabase
        .from("bot_sessions")
        .select("current_step, metadata")
        .eq("chat_id", chatId)
        .maybeSingle();
        
      if (error || !data) return { current_step: "IDLE", metadata: {} };
      return data;
    }

    async function updateSession(chatId: number, step: string, metadata: any) {
      await supabase.from("bot_sessions").upsert({
        chat_id: chatId,
        current_step: step,
        metadata: metadata || {},
        updated_at: new Date().toISOString()
      });
    }

    // ==========================================
    // UI BUILDERS
    // ==========================================
    function getBloodGroupKeyboard(prefix: string) {
      return new InlineKeyboard()
        .text("A+", `${prefix}:A+`).text("A-", `${prefix}:A-`)
        .text("B+", `${prefix}:B+`).text("B-", `${prefix}:B-`).row()
        .text("O+", `${prefix}:O+`).text("O-", `${prefix}:O-`)
        .text("AB+", `${prefix}:AB+`).text("AB-", `${prefix}:AB-`);
    }

    async function showDivisions(ctx: any, stepText: string = "Step 3/4") {
      const uniqueDivs = [
        "Barisal", "Chattogram", "Dhaka", "Khulna",
        "Mymensingh", "Rajshahi", "Rangpur", "Sylhet"
      ];
      
      const kb = new InlineKeyboard();
      for (let i = 0; i < uniqueDivs.length; i += 2) {
        kb.text(uniqueDivs[i], `div:${uniqueDivs[i]}`);
        if (uniqueDivs[i + 1]) kb.text(uniqueDivs[i + 1], `div:${uniqueDivs[i + 1]}`);
        kb.row();
      }
      await ctx.reply(`📍 ${stepText}: Select your Division:`, { reply_markup: kb });
    }

    // ==========================================
    // COMMANDS
    // ==========================================
    bot.command("start", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      await updateSession(chatId, "REG_NAME", { flow: "REGISTER" });
      await ctx.reply("🩸 **Welcome to the BD Blood Network!**\n\nTo begin registration, please type your **Full Name**:", { parse_mode: "Markdown" });
    });

    bot.command("request", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      await updateSession(chatId, "REQ_BLOOD", { flow: "REQUEST" });
      await ctx.reply("🚨 **Emergency Blood Matcher**\nSelect the required Blood Group:", { 
        reply_markup: getBloodGroupKeyboard("blood"), parse_mode: "Markdown"
      });
    });

    bot.command("cancel", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      await updateSession(chatId, "IDLE", {});
      await ctx.reply("❌ Cancelled. Type /start to register or /request to find blood.", { reply_markup: { remove_keyboard: true } });
    });

    // ==========================================
    // MENUS & ROUTING (The Fixes are here)
    // ==========================================
    bot.on("callback_query:data", async (ctx) => {
      // Prevent button loading spinner from hanging
      await ctx.answerCallbackQuery().catch(() => {});
      
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const [action, value] = ctx.callbackQuery.data.split(":");
      const session = await getSession(chatId);
      const meta = session.metadata || {};

      try {
        if (action === "blood" && session.current_step === "REQ_BLOOD") {
          meta.bloodGroup = value;
          await updateSession(chatId, "SELECT_DIVISION", meta);
          await ctx.editMessageText(`✅ Selected Blood Group: <b>${value}</b>`, { parse_mode: "HTML" });
          await showDivisions(ctx, "Step 2/5");
        }

        // --- DIVISION HANDLER FIX ---
        else if (action === "div" && session.current_step === "SELECT_DIVISION") {
          meta.division = value;
          await updateSession(chatId, "SELECT_DISTRICT", meta);
          
          // FIX: Used .ilike() for case-insensitive matching to prevent data mismatch crashes
          const { data: dists, error } = await supabase.from("location_data").select("district").ilike("division", `%${value}%`);
          
          // FIX: Precise error reporting to Telegram
          if (error) {
              return ctx.editMessageText(`⚠️ **Database Blocked:** Supabase RLS is preventing access.\nError: ${error.message}`, { parse_mode: "Markdown" });
          }
          if (!dists || dists.length === 0) {
              return ctx.editMessageText(`⚠️ **Missing Data:** No districts found in your database for "${value}". Make sure your location_data table is populated.`, { parse_mode: "Markdown" });
          }

          const uniqueDists = Array.from(new Set(dists.map((i) => i.district)));
          const kb = new InlineKeyboard();
          for (let i = 0; i < uniqueDists.length; i += 2) {
            kb.text(uniqueDists[i], `dist:${uniqueDists[i]}`);
            if (uniqueDists[i + 1]) kb.text(uniqueDists[i + 1], `dist:${uniqueDists[i + 1]}`);
            kb.row();
          }
          await ctx.editMessageText(`📍 Selected Division: <b>${value}</b>\nNow, select District:`, { reply_markup: kb, parse_mode: "HTML" });
        }

        // --- DISTRICT HANDLER FIX ---
        else if (action === "dist" && session.current_step === "SELECT_DISTRICT") {
          meta.district = value;
          await updateSession(chatId, "SELECT_UPAZILA", meta);
          
          const { data: upzs, error } = await supabase.from("location_data").select("upazila").ilike("district", `%${value}%`);
          
          if (error) {
              return ctx.editMessageText(`⚠️ **Database Blocked:** Supabase RLS is preventing access.\nError: ${error.message}`, { parse_mode: "Markdown" });
          }
          if (!upzs || upzs.length === 0) {
              return ctx.editMessageText(`⚠️ **Missing Data:** No upazilas found for "${value}".`, { parse_mode: "Markdown" });
          }
          
          const kb = new InlineKeyboard();
          for (let i = 0; i < upzs.length; i += 2) {
            kb.text(upzs[i].upazila, `upz:${upzs[i].upazila}`);
            if (upzs[i + 1]) kb.text(upzs[i + 1].upazila, `upz:${upzs[i + 1].upazila}`);
            kb.row();
          }
          await ctx.editMessageText(`📍 Selected District: <b>${value}</b>\nNow, select Upazila:`, { reply_markup: kb, parse_mode: "HTML" });
        }

        else if (action === "upz" && session.current_step === "SELECT_UPAZILA") {
          meta.upazila = value;
          await ctx.editMessageText(`📍 Location Locked: <b>${value}, ${meta.district}</b>`, { parse_mode: "HTML" });

          if (meta.flow === "REGISTER") {
            await updateSession(chatId, "REG_BLOOD", meta);
            await ctx.reply("📋 Step 4/4: Select your Blood Group to enter the database:", { reply_markup: getBloodGroupKeyboard("regbg") });
          } 
          else if (meta.flow === "REQUEST") {
            await updateSession(chatId, "REQ_BAGS", meta);
            const kb = new InlineKeyboard()
                .text("1 Bag", "bags:1").text("2 Bags", "bags:2").text("3 Bags", "bags:3").row()
                .text("4 Bags", "bags:4").text("5 Bags", "bags:5").text("Urgent (5+)", "bags:5+");
            await ctx.reply("🩸 How many bags of blood are required?", { reply_markup: kb });
          }
        }

        else if (action === "bags" && session.current_step === "REQ_BAGS") {
            meta.bags = value;
            await updateSession(chatId, "REQ_HOSPITAL", meta);
            await ctx.editMessageText(`✅ Selected Bags: <b>${value}</b>`, { parse_mode: "HTML" });
            await ctx.reply("🏥 Type the name of the Hospital/Clinic:");
        }

        else if (action === "regbg" && session.current_step === "REG_BLOOD") {
          await supabase.from("telegram_donors").upsert({
            chat_id: chatId, full_name: meta.name, phone_number: meta.phone,
            blood_group: value, division: meta.division, district: meta.district, upazila: meta.upazila
          });
          await updateSession(chatId, "IDLE", {});
          await ctx.editMessageText(`✅ Complete Profile Blood Group: <b>${value}</b>`, { parse_mode: "HTML" });
          await ctx.reply(`🎉 **Registration Successful, ${escapeHtml(meta.name)}!**\nYou will receive alerts when blood is needed in ${escapeHtml(meta.upazila)}.`, { parse_mode: "HTML" });
        }

      } catch (err) {
        console.error("Handler Error:", err);
        await ctx.reply("⚠️ An unexpected error occurred. Use /cancel and try again.");
      }
    });

    // ==========================================
    // TEXT HANDLERS
    // ==========================================
    bot.on("message:contact", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const session = await getSession(chatId);
      
      if (session.current_step === "REG_PHONE") {
        const phone = ctx.message.contact.phone_number;
        await updateSession(chatId, "SELECT_DIVISION", { ...session.metadata, phone });
        await ctx.reply("✅ Phone saved.", { reply_markup: { remove_keyboard: true } });
        await showDivisions(ctx, "Step 3/4");
      }
    });

    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return; 
      
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const session = await getSession(chatId);
      const meta = session.metadata || {};

      if (session.current_step === "REG_NAME") {
        await updateSession(chatId, "REG_PHONE", { ...meta, name: text });
        await ctx.reply(`Thank you, *${escapeHtml(text)}*.\n\n📱 **Step 2/4:** Please share your contact number:`, {
          reply_markup: new Keyboard().requestContact("Share Phone Number").oneTime().resized(), parse_mode: "Markdown"
        });
      }
      
      else if (session.current_step === "REG_PHONE") {
        if (!PHONE_REGEX.test(text)) return ctx.reply("⚠️ Invalid format (e.g. 01712345678):");
        await updateSession(chatId, "SELECT_DIVISION", { ...meta, phone: text });
        await ctx.reply("✅ Phone saved.", { reply_markup: { remove_keyboard: true } });
        await showDivisions(ctx, "Step 3/4");
      }
      
      else if (session.current_step === "REQ_HOSPITAL") {
        await updateSession(chatId, "REQ_PHONE", { ...meta, hospital: text });
        await ctx.reply("📞 Enter an emergency contact number:");
      } 
      
      else if (session.current_step === "REQ_PHONE") {
        if (!PHONE_REGEX.test(text)) return ctx.reply("⚠️ Invalid format (e.g. 01712345678):");
        await updateSession(chatId, "REQ_PROBLEM", { ...meta, contact_phone: text });
        await ctx.reply("🩺 Briefly describe the patient's condition (e.g. Surgery, Dengue):");
      } 
      
      else if (session.current_step === "REQ_PROBLEM") {
        const finalMeta = { ...meta, problem: text };
        await ctx.reply("⏳ Searching for local donors...");

        const { data: donors } = await supabase.rpc("find_eligible_matching_donors", {
          target_blood_group: finalMeta.bloodGroup,
          target_district: finalMeta.district,
          target_upazila: finalMeta.upazila
        });

        if (donors && donors.length > 0) {
            const alertMsg = `🚨 <b>URGENT BLOOD REQUEST</b> 🚨\n\n` +
                             `🩸 <b>Blood Group:</b> ${escapeHtml(finalMeta.bloodGroup)}\n` +
                             `🎒 <b>Bags Needed:</b> ${escapeHtml(finalMeta.bags)}\n` +
                             `🏥 <b>Hospital:</b> ${escapeHtml(finalMeta.hospital)}\n` +
                             `📍 <b>Location:</b> ${escapeHtml(finalMeta.upazila)}, ${escapeHtml(finalMeta.district)}\n` +
                             `🩺 <b>Condition:</b> ${escapeHtml(finalMeta.problem)}\n` +
                             `📞 <b>Contact:</b> ${escapeHtml(finalMeta.contact_phone)}`;

            let successCount = 0;
            const donorChunks = chunkArray(donors, 10);
            for (const chunk of donorChunks) {
              await Promise.allSettled(chunk.map(async (donor) => {
                  if (Number(donor.matched_chat_id) === chatId) return;
                  try {
                    await bot.api.sendMessage(donor.matched_chat_id, alertMsg, { parse_mode: "HTML" });
                    successCount++;
                  } catch (e) {}
              }));
            }
            await ctx.reply(`✅ Broadcast complete. Alert sent to ${successCount} donors in ${escapeHtml(finalMeta.upazila)}.`);
        } else {
            await ctx.reply(`⚠️ No registered ${escapeHtml(finalMeta.bloodGroup)} donors found in ${escapeHtml(finalMeta.upazila)}.`);
        }
        await updateSession(chatId, "IDLE", {});
      }
    });

    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};