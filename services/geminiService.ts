const API_BASE_URL = typeof window !== 'undefined' && window.location.hostname === 'localhost'
  ? 'http://localhost:8080'
  : ''; // Use relative path in production (same domain)

export const generateImageContent = async (prompt: string, size: "1K" | "2K" | "4K" = "1K"): Promise<string | null> => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, size })
    });
    const data = await response.json();
    return data.imageUrl || null;
  } catch (error) {
    console.error("Image generation failed:", error);
    return null;
  }
};

export const generateSimulationCode = async (prompt: string): Promise<string | null> => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/generate-simulation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const data = await response.json();
    return data.code || null;
  } catch (error) {
    console.error("Simulation generation failed:", error);
    return null;
  }
};

export const generateVectorDrawing = async (prompt: string): Promise<any[] | null> => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/generate-vector`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const data = await response.json();
    return data.elements || [];
  } catch (error) {
    console.error("Vector generation failed:", error);
    return null;
  }
};

export const sendChatProxy = async (messages: any[], screenshot: string | null, tools: any[], systemInstruction: string): Promise<any> => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, screenshot, tools, systemInstruction })
    });
    return await response.json();
  } catch (error) {
    console.error("Chat failed:", error);
    return { error: "Connection failed" };
  }
};