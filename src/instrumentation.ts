export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startWhatsApp } = await import("@/lib/whatsapp");
  void startWhatsApp().catch((error: unknown) => {
    console.error("WhatsApp startup failed", {
      reason: error instanceof Error ? error.message : "unknown error",
    });
  });
}
