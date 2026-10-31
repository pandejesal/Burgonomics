import fs from 'fs';

function extractSessionReport(filePath, sessionTitle) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const messages = data.messages || [];
    
    console.log(`\n================================================================================`);
    console.log(`SESSION: ${sessionTitle} (${messages.length} messages)`);
    console.log(`================================================================================`);
    
    const userPrompts = [];
    const textOutputs = [];
    const toolsUsed = {};
    const filesTouched = new Set();
    
    for (const msg of messages) {
      if (msg.type === 'user' && msg.text) {
        userPrompts.push(msg.text.trim());
      } else if (msg.type === 'assistant' && Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === 'text' && item.text) {
            textOutputs.push(item.text.trim());
          } else if (item.type === 'tool') {
            toolsUsed[item.name] = (toolsUsed[item.name] || 0) + 1;
            const input = item.state?.input || {};
            if (input.filePath) filesTouched.add(input.filePath);
            if (input.path) filesTouched.add(input.path);
            if (input.command) {
              const cmd = String(input.command);
              if (cmd.includes('npm') || cmd.includes('git') || cmd.includes('test')) {
                // key commands
              }
            }
          }
        }
      }
    }
    
    console.log(`* Initial Request:`);
    console.log(userPrompts[0]?.slice(0, 250).replace(/\r?\n/g, ' '));
    
    if (userPrompts.length > 1) {
      console.log(`* Last User Request:`);
      console.log(userPrompts[userPrompts.length - 1]?.slice(0, 250).replace(/\r?\n/g, ' '));
    }
    
    console.log(`* Tools Executed:`, JSON.stringify(toolsUsed));
    console.log(`* Key Files Touched (${filesTouched.size}):`, Array.from(filesTouched).slice(0, 8).join(', '));
    
    console.log(`* Latest Assistant Responses (Last 2):`);
    const recent = textOutputs.slice(-2);
    for (const r of recent) {
      console.log(`--- [Summary] ---`);
      console.log(r.slice(-800));
    }
  } catch (err) {
    console.error(`Failed reading ${filePath}:`, err.message);
  }
}

extractSessionReport('scripts/session_ui_ux.json', 'Session 1: Customer App UI/UX & Screens');
extractSessionReport('scripts/session_partner.json', 'Session 2: Partner App Production Finalization');
extractSessionReport('scripts/session_stream3.json', 'Session 3: Backend POS, Petpooja & Dispatch Router');
