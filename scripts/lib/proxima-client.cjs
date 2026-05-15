const http = require('http');
const url = require('url');

async function askProxima(message, model, baseUrl = 'http://localhost:3210') {
    const targetUrl = new url.URL('/v1/chat/completions', baseUrl);
    
    // Using the shape suggested by user: { model, message, stream: false }
    const payload = JSON.stringify({
        model: model,
        message: message,
        stream: false
    });

    return new Promise((resolve, reject) => {
        const req = http.request(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 300000 // 5 minutes
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const json = JSON.parse(data);
                        // Support both OpenAI format and potential custom format
                        if (json.choices && json.choices[0] && json.choices[0].message) {
                            resolve(json.choices[0].message.content);
                        } else if (json.response) {
                            resolve(json.response);
                        } else {
                            reject(new Error('Unexpected response format from Proxima'));
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse Proxima response: ${e.message}`));
                    }
                } else {
                    reject(new Error(`Proxima returned status ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (e) => {
            if (e.code === 'ECONNREFUSED') {
                reject(new Error(`Proxima is unavailable at ${baseUrl}. Is it running?`));
            } else {
                reject(e);
            }
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request to Proxima timed out'));
        });

        req.write(payload);
        req.end();
    });
}

module.exports = { askProxima };
