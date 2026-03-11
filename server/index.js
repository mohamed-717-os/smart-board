import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from "@google/genai";
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());

// Serve Static Frontend Files
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;

if (!GEMINI_API_KEY) {
    console.error("CRITICAL: GEMINI_API_KEY environment variable is missing.");
} else {
    console.log(`API Key loaded. Length: ${GEMINI_API_KEY.length}. Starts with: ${GEMINI_API_KEY.substring(0, 8)}...`);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY || '' });

// Proxy for Image Generation
app.post('/api/generate-image', async (req, res) => {
    try {
        const { prompt, size = "1K" } = req.body;
        const fullPrompt = `${prompt}. Minimalist style, isolated subject on white background if possible, high quality.`;

        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: { parts: [{ text: fullPrompt }] },
            config: {
                imageConfig: { imageSize: size, aspectRatio: "1:1" }
            }
        });

        for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
                return res.json({ imageUrl: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` });
            }
        }
        res.status(500).json({ error: "No image generated" });
    } catch (error) {
        console.error("Image generation failed:", error);
        res.status(500).json({ error: error.message });
    }
});

// Proxy for Simulation Code
app.post('/api/generate-simulation', async (req, res) => {
    try {
        const { prompt } = req.body;
        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-preview',
            contents: {
                parts: [{
                    text: `Create a self-contained, interactive HTML/JS simulation for: "${prompt}". 
        - Use Tailwind CSS for styling.
        - Important: Use a clean, modern design with a WHITE background (bg-white) and dark text (text-slate-900) to fit a light-mode whiteboard.
        - It must fit within a 500x400px container.
        - Return ONLY the HTML code (no markdown fences). 
        - Ensure it is visually appealing and interactive.` }]
            }
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
        res.json({ code: text ? text.replace(/```html/g, '').replace(/```/g, '').trim() : null });
    } catch (error) {
        console.error("Simulation generation failed:", error);
        res.status(500).json({ error: error.message });
    }
});

// Proxy for Chat
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, screenshot } = req.body;

        // Convert messages to GenAI format
        const contents = messages.map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: m.text }]
        }));

        // If there's a screenshot, add it to the last user message
        if (screenshot) {
            const lastUserMsg = [...contents].reverse().find(c => c.role === 'user');
            if (lastUserMsg) {
                lastUserMsg.parts.push({
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: screenshot
                    }
                });
            }
        }

        const result = await ai.models.generateContent({
            model: 'gemini-3-pro-preview', // Or whatever thinking model they use
            contents,
            config: {
                tools: [{ functionDeclarations: req.body.tools }],
                systemInstruction: req.body.systemInstruction
            }
        });

        const responsePart = result.candidates?.[0]?.content?.parts?.[0];
        res.json({
            text: responsePart?.text || null,
            functionCalls: result.candidates?.[0]?.content?.parts?.filter(p => p.functionCall) || []
        });
    } catch (error) {
        console.error("Chat failed:", error);
        res.status(500).json({ error: error.message });
    }
});

// Proxy for Vector Drawing


// Proxy for Vector Drawing
app.post('/api/generate-vector', async (req, res) => {
    try {
        const { prompt } = req.body;
        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-preview',
            contents: {
                parts: [{
                    text: `Generate a vector drawing for: "${prompt}".
        Return a JSON object with a "elements" property containing an array of shapes.
        Supported shapes:
        - { type: "rect", x, y, width, height, color, filled }
        - { type: "circle", x, y, radius, color, filled }
        - { type: "triangle", x, y, width, height, color, filled }
        - { type: "line", x1, y1, x2, y2, color, strokeWidth }
        - { type: "path", pathData, color, strokeWidth }
        Coordinates should be relative to (0,0) as the top-left of the drawing.
        Output ONLY JSON.` }]
            },
            config: { responseMimeType: "application/json" }
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
        res.json(JSON.parse(text || '{}'));
    } catch (error) {
        console.error("Vector generation failed:", error);
        res.status(500).json({ error: error.message });
    }
});

// Catch-all route to serve the SPA

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// WebSocket Relay for Multimodal Live API
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname === '/api/live') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (clientWs) => {
    console.log('Client connected to Live API Proxy');

    if (!GEMINI_API_KEY) {
        console.error('WebSocket Error: GEMINI_API_KEY is missing');
        clientWs.close(1011, 'Server API Key missing');
        return;
    }

    const googleUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BiDiGenerateContent?key=${GEMINI_API_KEY}`;
    const googleWs = new WebSocket(googleUrl);

    googleWs.on('open', () => {
        console.log('Connected to Google Live API');
    });

    googleWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
        }
    });

    clientWs.on('message', (data) => {
        if (googleWs.readyState === WebSocket.OPEN) {
            googleWs.send(data);
        }
    });

    googleWs.on('close', (code, reason) => {
        console.log(`Google API closed: ${code} ${reason}`);
        clientWs.close(code, reason);
    });

    clientWs.on('close', (code, reason) => {
        console.log(`Client disconnected: ${code} ${reason}`);
        googleWs.close(code, reason);
    });

    googleWs.on('error', (err) => {
        console.error('Google WebSocket Error:', err);
        clientWs.send(JSON.stringify({ error: 'Google API connection error' }));
    });

    clientWs.on('error', (err) => {
        console.error('Client WebSocket Error:', err);
        googleWs.close();
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Smart Board Proxy listening on port ${PORT}`);
});
