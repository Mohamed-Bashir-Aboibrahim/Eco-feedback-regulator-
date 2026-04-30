

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    const selectedTab = document.getElementById(`tab-${tabId}`);
    if (selectedTab) selectedTab.classList.add('active');

    document.querySelectorAll('.nav-btn').forEach(btn => {
        if(btn.innerText.toLowerCase().includes(tabId)) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    if (tabId === 'logs') fetchHistory(); 
}

const previousValues = { airTemp: 0, airHum: 0, soilTemp: 0, soilMoist: 0, light: 0 };

const maxValues = {
    airTemp: 50,    
    airHum: 100,    
    soilTemp: 50,   
    soilMoist: 100, 
    light: 4095     
};

const circumferences = { airTemp: 263.8, airHum: 263.8, soilTemp: 263.8, soilMoist: 263.8 };

function animateValue(id, start, end, duration, decimals = 1) {
    const obj = document.getElementById(`val-${id}`);
    if (!obj) return;

    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        const currentVal = (progress * (end - start) + start);
        obj.innerHTML = currentVal.toFixed(decimals);
        if (progress < 1) { window.requestAnimationFrame(step); }
    };
    window.requestAnimationFrame(step);
}

function updateGauge(id, value) {
    const prev = previousValues[id];
    const isFloat = id.includes('Temp') || id === 'airHum';
    animateValue(id, prev, value, 800, isFloat ? 1 : 0);
    previousValues[id] = value;

    if (id === 'light') {
        const bar = document.getElementById('bar-light');
        if(bar) {
            let percent = (value / maxValues.light) * 100;
            if (percent > 100) percent = 100;
            bar.style.width = percent + "%";
        }
    } else {
        const circle = document.getElementById(`svg-${id}`);
        if(circle) {
            const c = circumferences[id] || 263.8;
            let percent = value / maxValues[id];
            if (percent > 1) percent = 1;
            if (percent < 0) percent = 0;

            const offset = c - (percent * c);
            circle.style.strokeDashoffset = offset;
        }
    }
}

const firebaseConfig = {
    apiKey: "AIzaSyCzzoLBhc5w4Uy57EREbIKpBX8TbGoRvOk",
    databaseURL: "https://cap-website-f4197-default-rtdb.firebaseio.com/"
};

function initFirebase() {
    firebase.initializeApp(firebaseConfig);
    const db = firebase.database();

    const statusLabel = document.getElementById('conn-status');
    db.ref('.info/connected').on('value', function(snapshot) {
        if (snapshot.val() === true) {
            statusLabel.innerText = "CLOUD SYNC";
            statusLabel.className = "text-emerald border border-emerald/30 bg-emerald/10 rounded-lg px-3 py-1 shadow-[0_0_8px_rgba(16,185,129,0.4)] transition-all";
        } else {
            statusLabel.innerText = "LOCAL LOGGING";
            statusLabel.className = "text-amber-500 border border-amber-500/50 bg-amber-500/10 rounded px-2 py-0.5";
        }
    });

    db.ref('/telemetry').on('value', (snapshot) => {
        const data = snapshot.val();
        if(data) {
            if (data.airTemp !== undefined) updateGauge('airTemp', parseFloat(data.airTemp));
            if (data.airHum !== undefined) updateGauge('airHum', parseFloat(data.airHum));
            if (data.soilTemp !== undefined) updateGauge('soilTemp', parseFloat(data.soilTemp));
            if (data.soilMoist !== undefined) updateGauge('soilMoist', parseInt(data.soilMoist));
            if (data.light !== undefined) updateGauge('light', parseInt(data.light));
        }
    });

    db.ref('/controls').on('value', (snapshot) => {
        const data = snapshot.val();
        if(data) {
            ['pump', 'light', 'heater', 'fan'].forEach(device => {
                if(data[device] !== undefined) syncRelayUI(device, data[device]);
            });
        }
    }, (error) => { console.error("Firebase Controls Stream Error:", error); });

    db.ref('/plants').on('value', (snapshot) => {
        window.plantsLibrary = snapshot.val() || {};
        renderPlantList();
    }, (error) => { alert("Warning: Cannot read Database Library. " + error.message); });

    db.ref('/activePlant').on('value', (snapshot) => {
        window.currentActivePlantId = snapshot.val();
        renderPlantList(); 
    }, (error) => {});

    db.ref('/esp_status/last_seen').on('value', (snapshot) => {
        window.espLastSeen = snapshot.val() || 0;
    });

    setInterval(checkHardwareStatus, 5000);
}

function syncRelayUI(relayName, state) {
    const btn = document.getElementById(`btn-${relayName}`);
    if(!btn) return;

    if (state === "ON") {
        btn.classList.add('active');
        btn.dataset.state = "ON";
    } else {
        btn.classList.remove('active');
        btn.dataset.state = "OFF";
    }
}

function toggleRelay(relayName) {
    const btn = document.getElementById(`btn-${relayName}`);
    if(!btn) return;

    const targetState = btn.dataset.state === "ON" ? "OFF" : "ON";
    syncRelayUI(relayName, targetState); 

    firebase.database().ref(`/controls/${relayName}`).set(targetState);
}

const charts = {
    airTemp: null,
    airHum: null,
    soilTemp: null,
    soilMoist: null,
    light: null
};
let currentHistoryRef = null;

function renderChartData(snapshot) {
    const data = snapshot.val();
    if(!data) return;

    const labels = [];
    const datastores = {
        airTemp: [],
        airHum: [],
        soilTemp: [],
        soilMoist: [],
        light: []
    };

    Object.values(data).forEach((entry, index) => {
        labels.push(`Read ${index + 1}`); 
        if (entry.airTemp !== undefined) datastores.airTemp.push(entry.airTemp);
        if (entry.airHum !== undefined) datastores.airHum.push(entry.airHum);
        if (entry.soilTemp !== undefined) datastores.soilTemp.push(entry.soilTemp);
        if (entry.soilMoist !== undefined) datastores.soilMoist.push(entry.soilMoist);
        if (entry.light !== undefined) datastores.light.push(entry.light);
    });

    Object.keys(charts).forEach(key => {
        if(charts[key]) {
            charts[key].data.labels = labels;
            charts[key].data.datasets[0].data = datastores[key];
            charts[key].update();
        }
    });
}

function fetchHistory(limit = 180) { 
    if(currentHistoryRef) currentHistoryRef.off('value'); 

    const configs = {
        airTemp: { label: 'Air Temp (°C)', color: '#EF4444', bgColor: 'rgba(239, 68, 68, 0.1)', unit: '°C', min: 0, max: 60 },
        airHum: { label: 'Air Moisture (%)', color: '#06B6D4', bgColor: 'rgba(6, 182, 212, 0.1)', unit: '%', min: 0, max: 100 },
        soilTemp: { label: 'Soil Temp (°C)', color: '#F59E0B', bgColor: 'rgba(245, 158, 11, 0.1)', unit: '°C', min: 0, max: 60 },
        soilMoist: { label: 'Soil Moisture (%)', color: '#10B981', bgColor: 'rgba(16, 185, 129, 0.1)', unit: '%', min: 0, max: 100 },
        light: { label: 'Light (LUX)', color: '#EAB308', bgColor: 'rgba(234, 179, 8, 0.1)', unit: ' LUX', min: 0, max: 4095 }
    };

    Object.keys(configs).forEach(key => {
        const canvas = document.getElementById(`chart-${key}`);
        if(!canvas) return;

        if(charts[key]) charts[key].destroy();

        charts[key] = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: configs[key].label,
                    borderColor: configs[key].color,
                    backgroundColor: configs[key].bgColor,
                    data: [],
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: limit === 0 ? 0 : 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                color: 'rgba(255,255,255,0.7)',
                scales: {
                    x: { ticks: { color: 'rgba(255,255,255,0.5)', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: { 
                        min: configs[key].min,
                        max: configs[key].max,
                        ticks: { 
                            color: 'rgba(255,255,255,0.5)',
                            callback: function(value) {
                                return value + configs[key].unit;
                            }
                        }, 
                        grid: { color: 'rgba(255,255,255,0.05)' } 
                    }
                },
                plugins: {
                    legend: { display: false } 
                }
            }
        });
    });

    const ref = firebase.database().ref('/history');

    if (limit > 0) {

        currentHistoryRef = ref.limitToLast(limit);
        currentHistoryRef.on('value', renderChartData);
    } else {

        alert("Downloading Full Database Archive...\nWarning: If this data is massively large, the browser may lag heavily while rendering.");
        ref.once('value', renderChartData);
    }
}

function loadFullHistory() {
    fetchHistory(0);
}

function renderPlantList() {
    const container = document.getElementById('plant-list-container');
    if(!container) return;

    container.innerHTML = '';
    const plants = window.plantsLibrary || {};
    const activeId = window.currentActivePlantId;

    Object.keys(plants).forEach(key => {
        const plant = plants[key];
        const isActive = (key === activeId);

        const div = document.createElement('div');
        div.className = `p-4 rounded-2xl border cursor-pointer transition-all duration-300 flex justify-between items-center ${isActive ? 'bg-emerald/10 border-emerald/50' : 'bg-slate-800/40 border-slate-700/50 hover:bg-slate-800'}`;
        div.onclick = () => selectPlantProfile(key, plant);

        div.innerHTML = `
            <div>
                <h4 class="text-slate-200 font-bold font-ui text-sm">${plant.name || 'Unnamed Plant'}</h4>
                <p class="text-xs text-slate-500 font-number mt-1">Temp: ${plant.airTempMin}-${plant.airTempMax}°C | Moist: ${plant.soilMoistMin}-${plant.soilMoistMax}%</p>
            </div>
            ${isActive ? '<span class="text-[9px] font-number bg-emerald text-black px-2 py-1 rounded shadow uppercase font-bold tracking-widest">Active</span>' : ''}
        `;
        container.appendChild(div);
    });
}

function selectPlantProfile(id, data) {
    document.getElementById('plant-form').classList.remove('hidden');
    document.getElementById('btn-set-active').classList.remove('hidden');
    document.getElementById('form-plant-title').innerText = "Edit Profile";

    document.getElementById('plant-id').value = id;
    document.getElementById('plant-name').value = data.name || '';
    document.getElementById('plant-airTempMin').value = data.airTempMin || 0;
    document.getElementById('plant-airTempMax').value = data.airTempMax || 0;
    document.getElementById('plant-soilMoistMin').value = data.soilMoistMin || 0;
    document.getElementById('plant-soilMoistMax').value = data.soilMoistMax || 0;
    document.getElementById('plant-lightDark').value = data.lightDarkThreshold || 0;
    document.getElementById('plant-lightSun').value = data.lightSunlightThreshold || 0;

    const btn = document.getElementById('btn-submit-plant');
    if(btn) btn.innerText = "Save Changes";
}

function createNewPlant() {
    const id = "plant_" + Date.now();
    selectPlantProfile(id, { name: "New Plant Profile" });
    document.getElementById('form-plant-title').innerText = "Create New Profile";
    document.getElementById('btn-set-active').classList.add('hidden'); 

    const btn = document.getElementById('btn-submit-plant');
    if(btn) btn.innerText = "Create New Plant";
}

function savePlantProfile() {
    const id = document.getElementById('plant-id').value;
    if(!id) {
        alert("System Error: No profile ID active.");
        return;
    }

    const name = document.getElementById('plant-name').value;
    if(!name || name.trim() === "") {
        alert("Please enter a valid Plant Profile name before saving.");
        return;
    }

    const data = {
        name: name,
        airTempMin: parseFloat(document.getElementById('plant-airTempMin').value) || 0,
        airTempMax: parseFloat(document.getElementById('plant-airTempMax').value) || 0,
        soilMoistMin: parseInt(document.getElementById('plant-soilMoistMin').value) || 0,
        soilMoistMax: parseInt(document.getElementById('plant-soilMoistMax').value) || 0,
        lightDarkThreshold: parseInt(document.getElementById('plant-lightDark').value) || 0,
        lightSunlightThreshold: parseInt(document.getElementById('plant-lightSun').value) || 0
    };

    firebase.database().ref('/plants/' + id).set(data).then(() => {

        const btn = document.getElementById('btn-submit-plant');
        if(btn) {
            btn.innerText = "Saved Successfully!";
            btn.classList.add('bg-emerald', 'text-black');
            setTimeout(() => {
                btn.innerText = "Save Changes";
                btn.classList.remove('bg-emerald', 'text-black');
            }, 2000);
        }
    }).catch(error => {
        alert("CRITICAL FIREBASE PERMISSION ERROR:\n" + error.message + "\n\nYou probably need to change your Realtime Database Rules to allow read/write access to the entire tree.");
    });
}

function deletePlantProfile() {
    const id = document.getElementById('plant-id').value;
    if(!id) return;
    if(confirm("Are you sure you want to delete this plant profile?")) {
        firebase.database().ref('/plants/' + id).remove().then(() => {
            document.getElementById('plant-form').classList.add('hidden');
            document.getElementById('btn-set-active').classList.add('hidden');
            document.getElementById('form-plant-title').innerText = "Select a Plant";
        }).catch(error => {
            alert("Delete failed: " + error.message);
        });
    }
}

function setActivePlant() {
    const id = document.getElementById('plant-id').value;
    const plants = window.plantsLibrary || {};
    const plant = plants[id];

    if(!plant) {
        alert("Please save the plant profile first before activating it.");
        return;
    }

    if(confirm(`Deploy "${plant.name}" automation parameters to the ESP32 firmware?`)) {

        firebase.database().ref('/activePlant').set(id).catch(err => alert("Activation tracking failed: " + err.message));

        firebase.database().ref('/config').set(plant).then(() => {
            alert("Success! The ESP32 will transition to the new parameters within 30 seconds.");
        }).catch(err => {
            alert("Config Sync Failed: " + err.message);
        });
    }
}

function saveWiFiNetwork() {
    const ssid = document.getElementById('wifi-ssid').value.trim();
    const pass = document.getElementById('wifi-pass').value.trim();

    if(!ssid) {
        alert("SSID cannot be empty.");
        return;
    }

    if(confirm("Warning: Incorrect credentials will permanently knock the ESP32 offline until it falls back. Deploy?")) {
        firebase.database().ref('/wifi').set({
            ssid: ssid,
            password: pass
        }).then(() => {
            alert("Credentials deployed! ESP32 will verify config within 30 seconds, restart to attempt connection, or fallback if it fails.");
            document.getElementById('wifi-ssid').value = '';
            document.getElementById('wifi-pass').value = '';
        }).catch(err => {
            alert("Failed to write to Firebase: " + err.message);
        });
    }
}

function addFrenchThyme() {
    const defaultData = {
        name: "French Thyme",
        airTempMin: 17,
        airTempMax: 30,
        soilMoistMin: 30,
        soilMoistMax: 60,
        lightDarkThreshold: 1000,
        lightSunlightThreshold: 3000
    };

    const ref = firebase.database().ref('/plants').push();
    const id = ref.key;
    ref.set(defaultData).then(() => {

        firebase.database().ref('/activePlant').set(id);
        firebase.database().ref('/config').set(defaultData);
        alert("French Thyme has been created and set as the active automation profile!");
    }).catch(err => {
        alert("Failed to add French Thyme: " + err.message);
    });
}

function checkHardwareStatus() {
    const pulseElement = document.getElementById('esp-status-pulse');
    const dotElement = document.getElementById('esp-status-dot');
    const textElement = document.getElementById('esp-status-text');
    const lastSeenElement = document.getElementById('esp-last-seen');

    if(!textElement) return; 

    const now = Date.now();
    const lastSeen = window.espLastSeen || 0;
    const diff = now - lastSeen;

    if (lastSeen === 0) {
        lastSeenElement.innerText = "Last Seen: Never";
    } else {
        const secs = Math.floor(diff / 1000);
        if (secs < 60) lastSeenElement.innerText = `Last Seen: ${secs}s ago`;
        else lastSeenElement.innerText = `Last Seen: ${Math.floor(secs/60)}m ago`;
    }

    if (diff > 35000) { 

        textElement.innerText = "OFFLINE";
        textElement.className = "text-2xl font-black tracking-widest text-red-500 font-number";
        pulseElement.className = "absolute inset-0 rounded-full bg-red-500/0"; 
        dotElement.className = "w-4 h-4 rounded-full bg-slate-500 z-10 shadow-none"; 
    } else {
        textElement.innerText = "ONLINE";
        textElement.className = "text-2xl font-black tracking-widest text-emerald font-number";
        pulseElement.className = "absolute inset-0 rounded-full bg-emerald/30 animate-ping";
        dotElement.className = "w-4 h-4 rounded-full bg-emerald z-10 shadow-[0_0_10px_rgba(16,185,129,0.8)]";
    }
}

function initTheme() {
    const themeBtn = document.getElementById('theme-toggle');
    const darkIcon = document.getElementById('theme-toggle-dark-icon');
    const lightIcon = document.getElementById('theme-toggle-light-icon');

    if (localStorage.getItem('color-theme') === 'dark' || (!('color-theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
        lightIcon.classList.remove('hidden');
    } else {
        document.documentElement.classList.remove('dark');
        darkIcon.classList.remove('hidden');
    }

    themeBtn.addEventListener('click', () => {

        darkIcon.classList.toggle('hidden');
        lightIcon.classList.toggle('hidden');

        if (localStorage.getItem('color-theme')) {
            if (localStorage.getItem('color-theme') === 'light') {
                document.documentElement.classList.add('dark');
                localStorage.setItem('color-theme', 'dark');
            } else {
                document.documentElement.classList.remove('dark');
                localStorage.setItem('color-theme', 'light');
            }
        } else {
            if (document.documentElement.classList.contains('dark')) {
                document.documentElement.classList.remove('dark');
                localStorage.setItem('color-theme', 'light');
            } else {
                document.documentElement.classList.add('dark');
                localStorage.setItem('color-theme', 'dark');
            }
        }
    });
}

let serialPort = null;
let serialReader = null;
let serialWriter = null;

async function connectSerial() {
    if (!('serial' in navigator)) {
        alert('Web Serial API is not supported in your browser. Please use Chrome, Edge, or Opera.');
        return;
    }

    try {
        const terminal = document.getElementById('serial-terminal');
        
        if (serialPort) {
            if (serialReader) {
                await serialReader.cancel();
            }
            if (serialWriter) {
                await serialWriter.close();
            }
            await serialPort.close();
            serialPort = null;
            document.getElementById('btn-connect-serial').innerText = 'CONNECT ESP32';
            document.getElementById('btn-connect-serial').classList.remove('bg-red-500', 'hover:bg-red-600', 'shadow-red-500/20', 'border-red-500/50');
            document.getElementById('btn-connect-serial').classList.add('bg-emerald/90', 'hover:bg-emerald', 'shadow-emerald/20', 'border-emerald/50');
            terminal.innerHTML += `<div class="text-yellow-400">Disconnected from serial port.</div>`;
            return;
        }

        serialPort = await navigator.serial.requestPort();
        await serialPort.open({ baudRate: 115200 });

        document.getElementById('btn-connect-serial').innerText = 'DISCONNECT';
        document.getElementById('btn-connect-serial').classList.remove('bg-emerald/90', 'hover:bg-emerald', 'shadow-emerald/20', 'border-emerald/50');
        document.getElementById('btn-connect-serial').classList.add('bg-red-500', 'hover:bg-red-600', 'shadow-red-500/20', 'border-red-500/50');
        
        terminal.innerHTML = `<div class="text-emerald">Connected to ESP32 at 115200 baud!</div>`;
        
        readSerialLoop();
    } catch (err) {
        console.error('Serial connection error:', err);
        alert('Failed to connect to the serial port. ' + err.message);
    }
}

let serialBuffer = '';
let localChartCount = 0;

async function readSerialLoop() {
    const terminal = document.getElementById('serial-terminal');
    const textDecoder = new TextDecoderStream();
    
    // We don't await this so it runs continuously in the background
    const readableStreamClosed = serialPort.readable.pipeTo(textDecoder.writable);
    serialReader = textDecoder.readable.getReader();

    try {
        while (true) {
            const { value, done } = await serialReader.read();
            if (done) {
                break;
            }
            if (value) {
                const textNode = document.createTextNode(value);
                terminal.appendChild(textNode);
                terminal.scrollTop = terminal.scrollHeight;

                serialBuffer += value;
                let lines = serialBuffer.split('\n');
                serialBuffer = lines.pop(); // Keep the incomplete line in the buffer

                for (let line of lines) {
                    processSerialLine(line.trim());
                }
            }
        }
    } catch (error) {
        console.error('Serial read error:', error);
        terminal.innerHTML += `<div class="text-red-500">Serial read error: ${error.message}</div>`;
    } finally {
        serialReader.releaseLock();
    }
}

function processSerialLine(line) {
    if (line.includes('[SENSOR DATA]')) {
        // Example: [SENSOR DATA] Air Temp: 21.7C | Air Hum: 64.8% | Soil Temp: 26.6C | Soil Moist: 0% | Light: 1913
        const regex = /Air Temp: ([\d.]+)C \| Air Hum: ([\d.]+)% \| Soil Temp: ([\d.]+)C \| Soil Moist: (\d+)% \| Light: (\d+)/;
        const match = line.match(regex);
        if (match) {
            const data = {
                airTemp: parseFloat(match[1]),
                airHum: parseFloat(match[2]),
                soilTemp: parseFloat(match[3]),
                soilMoist: parseInt(match[4]),
                light: parseInt(match[5])
            };

            // Update local gauges
            updateGauge('airTemp', data.airTemp);
            updateGauge('airHum', data.airHum);
            updateGauge('soilTemp', data.soilTemp);
            updateGauge('soilMoist', data.soilMoist);
            updateGauge('light', data.light);

            // Update charts
            addLocalChartData(data);
        }
    }
}

function addLocalChartData(data) {
    localChartCount++;
    const label = `USB ${localChartCount}`;

    const mappings = {
        airTemp: data.airTemp,
        airHum: data.airHum,
        soilTemp: data.soilTemp,
        soilMoist: data.soilMoist,
        light: data.light
    };

    Object.keys(charts).forEach(key => {
        if (charts[key]) {
            const chart = charts[key];
            
            chart.data.labels.push(label);
            chart.data.datasets[0].data.push(mappings[key]);

            // Keep max 50 points so it doesn't freeze the browser
            if (chart.data.labels.length > 50) {
                chart.data.labels.shift();
                chart.data.datasets[0].data.shift();
            }

            chart.update('none'); // Update without full animation for smoother live feed
        }
    });
}

async function sendSerial() {
    if (!serialPort) {
        alert('Please connect to the ESP32 first.');
        return;
    }

    const input = document.getElementById('serial-input');
    const data = input.value + '\n';
    
    if (data.trim() === '') return;

    try {
        const textEncoder = new TextEncoderStream();
        const writableStreamClosed = textEncoder.readable.pipeTo(serialPort.writable);
        serialWriter = textEncoder.writable.getWriter();
        await serialWriter.write(data);
        await serialWriter.close(); // Close the writer to flush the stream
        
        const terminal = document.getElementById('serial-terminal');
        terminal.innerHTML += `<div class="text-blue-400">&gt; ${data}</div>`;
        terminal.scrollTop = terminal.scrollHeight;
        input.value = '';
    } catch (err) {
        console.error('Serial write error:', err);
        alert('Failed to send data: ' + err.message);
    }
}

window.onload = () => {
    initTheme();

    initFirebase();
    switchTab('dashboard');
};
