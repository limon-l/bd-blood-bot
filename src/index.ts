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
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function chunkArray<T>(array: T[], size: number): T[][] {
      const chunks: T[][] = [];
      for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
      }
      return chunks;
    }

    bot.catch((err) => {
      console.error("Global Grammy Error Caught:", err);
    });

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
        chat_id: chatId, current_step: step, metadata: metadata || {}, updated_at: new Date().toISOString()
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

      const { data: existingUser } = await supabase.from("telegram_donors").select("chat_id").eq("chat_id", chatId).maybeSingle();
      if (existingUser) {
        return ctx.reply("✅ <b>You are already registered in our database.</b>\n\nIf you need to find blood, please type /request.", { parse_mode: "HTML" });
      }

      await updateSession(chatId, "REG_NAME", { flow: "REGISTER" });
      await ctx.reply("🩸 <b>Welcome to the BD Blood Network!</b>\n\nTo begin registration, please type your <b>Full Name</b>:", { parse_mode: "HTML" });
    });

    bot.command("request", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const { data: existingUser } = await supabase.from("telegram_donors").select("chat_id").eq("chat_id", chatId).maybeSingle();
      if (!existingUser) {
        return ctx.reply("⚠️ <b>Access Denied:</b> You must be a registered donor to request blood.\n\nPlease type /start to register your profile first.", { parse_mode: "HTML" });
      }

      await updateSession(chatId, "REQ_BLOOD", { flow: "REQUEST" });
      await ctx.reply("🚨 <b>Emergency Blood Matcher</b>\nSelect the required Blood Group:", { 
        reply_markup: getBloodGroupKeyboard("blood"), parse_mode: "HTML"
      });
    });

    // NEW FEATURE: Profile Command
    bot.command("profile", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const { data: donor } = await supabase.from("telegram_donors").select("*").eq("chat_id", chatId).maybeSingle();
      if (!donor) return ctx.reply("⚠️ You are not registered yet. Type /start to register.");

      const lastDonated = donor.last_donation_date ? donor.last_donation_date : "Never / Not Updated";
      await ctx.reply(`👤 <b>Your Donor Profile</b>\n\n📛 <b>Name:</b> ${escapeHtml(donor.full_name)}\n🩸 <b>Blood Group:</b> ${escapeHtml(donor.blood_group)}\n📞 <b>Phone:</b> ${escapeHtml(donor.phone_number)}\n📍 <b>Location:</b> ${escapeHtml(donor.upazila)}, ${escapeHtml(donor.district)}\n📅 <b>Last Donated:</b> ${escapeHtml(lastDonated)}\n\n<i>To update your donation date, type /donated</i>`, { parse_mode: "HTML" });
    });

    // NEW FEATURE: Update Donation Date Command
    bot.command("donated", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const { data: existingUser } = await supabase.from("telegram_donors").select("chat_id").eq("chat_id", chatId).maybeSingle();
      if (!existingUser) return ctx.reply("⚠️ You must be a registered donor first. Type /start");

      await updateSession(chatId, "UPDATE_LAST_DONATION", {});
      await ctx.reply("📅 <b>Update Last Donation Date</b>\n\nPlease reply with the date you last donated blood in this format: <b>DD-MM-YYYY</b> (e.g. 15-08-2023)\n\n<i>Or type /cancel to abort.</i>", { parse_mode: "HTML" });
    });

    bot.command("cancel", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      await updateSession(chatId, "IDLE", {});
      await ctx.reply("❌ Cancelled. Type /start to register or /request to find blood.", { reply_markup: { remove_keyboard: true } });
    });

    // ==========================================
    // MENUS & ROUTING
    // ==========================================
    bot.on("callback_query:data", async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const parts = ctx.callbackQuery.data.split(":");
      const action = parts[0];
      const value = parts.slice(1).join(":"); 

      const session = await getSession(chatId);
      const meta = session.metadata || {};

      try {
        if (action === "blood" && session.current_step === "REQ_BLOOD") {
          meta.bloodGroup = value;
          await updateSession(chatId, "SELECT_DIVISION", meta);
          await ctx.editMessageText(`✅ Selected Blood Group: <b>${value}</b>`, { parse_mode: "HTML" });
          await showDivisions(ctx, "Step 2/5");
        }
        else if (action === "div" && session.current_step === "SELECT_DIVISION") {
          meta.division = value;
          await updateSession(chatId, "SELECT_DISTRICT", meta);
          const { data: dists } = await supabase.from("location_data").select("district").ilike("division", `%${value}%`);
          const uniqueDists = Array.from(new Set(dists?.map((i) => i.district)));
          const kb = new InlineKeyboard();
          for (let i = 0; i < uniqueDists.length; i += 2) {
            kb.text(uniqueDists[i], `dist:${uniqueDists[i]}`);
            if (uniqueDists[i + 1]) kb.text(uniqueDists[i + 1], `dist:${uniqueDists[i + 1]}`);
            kb.row();
          }
          await ctx.editMessageText(`📍 Selected Division: <b>${escapeHtml(value)}</b>\nNow, select District:`, { reply_markup: kb, parse_mode: "HTML" });
        }
        else if (action === "dist" && session.current_step === "SELECT_DISTRICT") {
          meta.district = value;
          await updateSession(chatId, "SELECT_UPAZILA", meta);
          const { data: upzs } = await supabase.from("location_data").select("upazila").ilike("district", `%${value}%`);
          const kb = new InlineKeyboard();
          for (let i = 0; i < (upzs?.length || 0); i += 2) {
            kb.text(upzs![i].upazila, `upz:${upzs![i].upazila}`);
            if (upzs![i + 1]) kb.text(upzs![i + 1].upazila, `upz:${upzs![i + 1].upazila}`);
            kb.row();
          }
          await ctx.editMessageText(`📍 Selected District: <b>${escapeHtml(value)}</b>\nNow, select Upazila:`, { reply_markup: kb, parse_mode: "HTML" });
        }
        else if (action === "upz" && session.current_step === "SELECT_UPAZILA") {
          meta.upazila = value;
          await ctx.editMessageText(`📍 Location Locked: <b>${escapeHtml(value)}, ${escapeHtml(meta.district)}</b>`, { parse_mode: "HTML" });
          if (meta.flow === "REGISTER") {
            await updateSession(chatId, "REG_BLOOD", meta);
            await ctx.reply("📋 Step 4/4: Select your Blood Group to enter the database:", { reply_markup: getBloodGroupKeyboard("regbg") });
          } else if (meta.flow === "REQUEST") {
            await updateSession(chatId, "REQ_BAGS", meta);
            const kb = new InlineKeyboard().text("1 Bag", "bags:1").text("2 Bags", "bags:2").text("3 Bags", "bags:3").row().text("4 Bags", "bags:4").text("5 Bags", "bags:5").text("Urgent (5+)", "bags:5+");
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
          await ctx.reply(`🎉 <b>Registration Successful, ${escapeHtml(meta.name)}!</b>\nYou will receive alerts when blood is needed in <b>${escapeHtml(meta.upazila)}</b>.`, { parse_mode: "HTML" });
        }

        // ==========================================
        // INTERACTIVE DONOR MATCHING
        // ==========================================
        else if (action === "avail") {
          const requesterChatId = Number(value);
          const { data: donor } = await supabase.from("telegram_donors").select("*").eq("chat_id", chatId).single();
          if (!donor) return;

          await ctx.editMessageReplyMarkup(); 
          await ctx.reply("✅ <b>Thank you!</b> Your contact info has been sent to the requester.", { parse_mode: "HTML" });

          const matchMsg = `🎉 <b>DONOR AVAILABLE!</b>\n\n👤 <b>Name:</b> ${escapeHtml(donor.full_name)}\n📞 <b>Phone:</b> ${escapeHtml(donor.phone_number)}\n🩸 <b>Blood Group:</b> ${escapeHtml(donor.blood_group)}\n\n<i>Please contact the donor immediately.</i>`;
          const matchKb = new InlineKeyboard().text("Got Blood! Thanks.", "managed");
          
          await bot.api.sendMessage(requesterChatId, matchMsg, { parse_mode: "HTML", reply_markup: matchKb }).catch(() => {});
        }
        
        else if (action === "unavail") {
          await ctx.editMessageReplyMarkup();
          await ctx.reply("❌ No problem. Thank you for updating us!");
        }

        // ==========================================
        // MULTI-BAG TRACKING LOGIC
        // ==========================================
        else if (action === "managed") {
          if (session.current_step !== "WAITING_DONOR") {
            return ctx.answerCallbackQuery({ text: "This request is already closed or expired.", show_alert: true });
          }

          const finalMeta = session.metadata || {};
          const totalBags = parseInt(finalMeta.bags) || 1;
          finalMeta.bags_managed = (finalMeta.bags_managed || 0) + 1;

          await ctx.editMessageReplyMarkup();

          if (finalMeta.bags_managed < totalBags) {
              const remaining = totalBags - finalMeta.bags_managed;
              await updateSession(chatId, "WAITING_DONOR", finalMeta);
              return ctx.reply(`✅ <b>1 bag successfully managed!</b>\n\nYou still need <b>${remaining}</b> more bag(s). The search is still active, waiting for more donors...`, { parse_mode: "HTML" });
          }

          await ctx.reply("✅ <b>All requested bags managed! Request closed.</b> Notifying donors that the emergency is fulfilled...", { parse_mode: "HTML" });

          const { data: donors } = await supabase
            .from("telegram_donors")
            .select("chat_id")
            .eq("blood_group", finalMeta.bloodGroup)
            .ilike("district", `%${(finalMeta.district || "").trim()}%`)
            .ilike("upazila", `%${(finalMeta.upazila || "").trim()}%`);

          if (donors && donors.length > 0) {
              const managedMsg = `✅ <b>UPDATE:</b> Already blood managed, Thanks.\n\n<i>(The emergency request for ${finalMeta.bloodGroup} in ${finalMeta.upazila} is fulfilled)</i>`;
              const donorChunks = chunkArray(donors, 10);
              
              for (const chunk of donorChunks) {
                await Promise.allSettled(chunk.map(async (d) => {
                    const targetChatId = Number(d.chat_id);
                    if (targetChatId === chatId) return; 
                    try { await bot.api.sendMessage(targetChatId, managedMsg, { parse_mode: "HTML" }); } catch (e) {}
                }));
              }
          }
          await updateSession(chatId, "IDLE", {});
        }

      } catch (err) {
        console.error("Handler Error:", err);
        await updateSession(chatId, "IDLE", {});
        await ctx.reply("⚠️ An unexpected error occurred. State reset. Please try again.");
      }
    });

    // ==========================================
    // TEXT HANDLERS & BROADCAST LOOP
    // ==========================================
    bot.on("message:contact", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const session = await getSession(chatId);
      if (session.current_step === "REG_PHONE") {
        await updateSession(chatId, "SELECT_DIVISION", { ...session.metadata, phone: ctx.message.contact.phone_number });
        await ctx.reply("✅ Phone saved.", { reply_markup: { remove_keyboard: true } });
        await showDivisions(ctx, "Step 3/4");
      }
    });

    bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith("/")) return; 
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      
      try {
        const session = await getSession(chatId);
        const meta = session.metadata || {};

        if (session.current_step === "REG_NAME") {
          await updateSession(chatId, "REG_PHONE", { ...meta, name: text });
          await ctx.reply(`Thank you, <b>${escapeHtml(text)}</b>.\n\n📱 <b>Step 2/4:</b> Please share your contact number:`, {
            reply_markup: new Keyboard().requestContact("Share Phone Number").oneTime().resized(), parse_mode: "HTML"
          });
        }
        else if (session.current_step === "REG_PHONE") {
          if (!PHONE_REGEX.test(text)) return ctx.reply("⚠️ Invalid format (e.g. 01712345678):");
          await updateSession(chatId, "SELECT_DIVISION", { ...meta, phone: text });
          await ctx.reply("✅ Phone saved.", { reply_markup: { remove_keyboard: true } });
          await showDivisions(ctx, "Step 3/4");
        }
        
        // NEW FEATURE: Date Parsing and Saving
        else if (session.current_step === "UPDATE_LAST_DONATION") {
          const dateRegex = /^(0[1-9]|[12][0-9]|3[01])-(0[1-9]|1[012])-\d{4}$/;
          if (!dateRegex.test(text)) {
            return ctx.reply("⚠️ <b>Invalid format.</b> Please use EXACTLY <b>DD-MM-YYYY</b> (e.g. 15-08-2023):", { parse_mode: "HTML" });
          }
          
          // Convert DD-MM-YYYY to YYYY-MM-DD for standard database storage
          const parts = text.split("-");
          const dbFormattedDate = `${parts[2]}-${parts[1]}-${parts[0]}`;

          await supabase.from("telegram_donors").update({ last_donation_date: dbFormattedDate }).eq("chat_id", chatId);
          await updateSession(chatId, "IDLE", {});
          await ctx.reply(`✅ <b>Date Updated!</b> Your last donation date has been successfully recorded.`, { parse_mode: "HTML" });
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
          const finalMeta = { ...meta, problem: text, bags_managed: 0 };
          
          await ctx.reply("⏳ Searching database and organizing alert system...");

          // NEW FEATURE: Automatic Prioritization Logic
          // .order() puts users who have NEVER donated (nullsFirst) or haven't donated in a long time (ascending) at the very front of the broadcast queue.
          const { data: donors } = await supabase
            .from("telegram_donors")
            .select("chat_id, last_donation_date")
            .eq("blood_group", finalMeta.bloodGroup)
            .ilike("district", `%${finalMeta.district.trim()}%`)
            .ilike("upazila", `%${finalMeta.upazila.trim()}%`)
            .order('last_donation_date', { ascending: true, nullsFirst: true });

          if (donors && donors.length > 0) {
              const alertMsg = `🚨 <b>URGENT BLOOD REQUEST</b> 🚨\n\n` +
                               `🩸 <b>Blood Group:</b> ${escapeHtml(finalMeta.bloodGroup)}\n` +
                               `🎒 <b>Bags Needed:</b> ${escapeHtml(finalMeta.bags)}\n` +
                               `🏥 <b>Hospital:</b> ${escapeHtml(finalMeta.hospital)}\n` +
                               `📍 <b>Location:</b> ${escapeHtml(finalMeta.upazila)}, ${escapeHtml(finalMeta.district)}\n` +
                               `🩺 <b>Condition:</b> ${escapeHtml(finalMeta.problem)}\n` +
                               `📞 <b>Contact:</b> ${escapeHtml(finalMeta.contact_phone)}`;

              const alertKb = new InlineKeyboard()
                .text("Available for donate", `avail:${chatId}`).row()
                .text("Not Available", "unavail");

              let successCount = 0;
              const donorChunks = chunkArray(donors, 10);
              
              for (const chunk of donorChunks) {
                await Promise.allSettled(chunk.map(async (donor) => {
                    const targetChatId = Number(donor.chat_id);
                    if (targetChatId === chatId) return; 
                    try {
                      await bot.api.sendMessage(targetChatId, alertMsg, { parse_mode: "HTML", reply_markup: alertKb });
                      successCount++;
                    } catch (e) { }
                }));
              }
              
              await ctx.reply(`✅ <b>Broadcast complete.</b>\nAlert successfully delivered to <b>${successCount}</b> eligible donors in <b>${escapeHtml(finalMeta.upazila)}</b>.`, { parse_mode: "HTML" });
              
              await updateSession(chatId, "WAITING_DONOR", finalMeta);
          } else {
              await ctx.reply(`⚠️ No registered <b>${escapeHtml(finalMeta.bloodGroup)}</b> donors found in <b>${escapeHtml(finalMeta.upazila)}</b> yet.`, { parse_mode: "HTML" });
              await updateSession(chatId, "IDLE", {});
          }
        }
      } catch (err) {
        console.error("Fatal Text Handler Error:", err);
        await updateSession(chatId, "IDLE", {});
        await ctx.reply("⚠️ An error occurred while processing your request. Please try again.");
      }
    });

    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};