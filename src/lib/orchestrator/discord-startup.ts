// Separate module for Discord startup to isolate discord.js from build-time analysis
export async function initializeDiscordBot(): Promise<void> {
  // Use string concatenation to prevent Turbopack from statically analyzing the import
  const discordPath = ["", ".", "", "discord", "client"].filter(Boolean).join("/").slice(1);
  const module = await import("./" + discordPath);
  const isDiscordConfigured = module.isDiscordConfigured;
  const startDiscordBot = module.startDiscordBot;

  if (isDiscordConfigured()) {
    await startDiscordBot();
    console.log("[orchestrator] Discord bot started");
  } else {
    console.log("[orchestrator] Discord bot not configured -- running without Discord integration");
  }
}
