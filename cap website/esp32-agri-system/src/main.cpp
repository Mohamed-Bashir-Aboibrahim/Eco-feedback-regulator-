#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <addons/RTDBHelper.h>
#include <Preferences.h>

#include <time.h>
#include <DHT.h>

#define DHT_PIN 4
#define SOIL_PIN 34
#define NTC_PIN 35
#define LDR_PIN 36

#define FAN_PIN 25
#define PUMP_PIN 26
#define HEATER_PIN 27
#define BUZZER_PIN 32

#define PWM_RED   13
#define PWM_WHITE 14
#define PWM_BLUE  15

#define DHT_TYPE DHT11

#define PWM_FREQ 5000
#define PWM_RES  8

const char* WIFI_SSID = "Mohamed";
const char* WIFI_PASS = "0123456789";

String activeSSID = WIFI_SSID;
String activePass = WIFI_PASS;

#define FIREBASE_URL "cap-website-f4197-default-rtdb.firebaseio.com"
#define FIREBASE_API_KEY "AIzaSyCzzoLBhc5w4Uy57EREbIKpBX8TbGoRvOk"

#define SENSOR_READ_INTERVAL_MS   2000    
#define FIREBASE_SYNC_INTERVAL_MS 5000    
#define FIREBASE_HISTORY_INTERVAL_MS 5000 

#define NTP_SERVER "pool.ntp.org"
#define GMT_OFFSET_SEC 10800 
#define DAYLIGHT_OFFSET_SEC 0

DHT dht(DHT_PIN, DHT_TYPE);

void initSensors() {
    dht.begin();
    pinMode(SOIL_PIN, INPUT);
    pinMode(NTC_PIN, INPUT);
    pinMode(LDR_PIN, INPUT);
    Serial.println("Sensors initialized (Real Hardware: DHT11, NTC, Soil Moisture, LDR).");
}

void readSensors(float &airTemp, float &airHum, float &soilTemp, int &soilMoisture, int &light) {

    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t) && !isnan(h)) {
        airTemp = t;
        airHum = h;
    } else {
        airTemp = 24.0; 
        airHum = 50.0;
    }

    int rawSoil = analogRead(SOIL_PIN);
    soilMoisture = map(rawSoil, 4095, 0, 0, 100); 
    if(soilMoisture < 0) soilMoisture = 0;
    if(soilMoisture > 100) soilMoisture = 100;

    light = analogRead(LDR_PIN);

    int rawNtc = analogRead(NTC_PIN);
    if(rawNtc == 0) {
        soilTemp = 21.0; 
    } else {

        float divisor = (4095.0 / (float)rawNtc - 1.0);
        if (divisor <= 0.0) {
            soilTemp = 21.0; 
        } else {
            float R = 10000.0 / divisor;
            float steinhart = R / 10000.0;
            steinhart = log(steinhart);
            steinhart /= 3950.0;
            steinhart += 1.0 / (25.0 + 273.15);
            steinhart = 1.0 / steinhart;
            soilTemp = steinhart - 273.15;
        }
    }
}

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig fbConfig;
FirebaseData stream;

Preferences preferences;

unsigned long lastSensorRead = 0;
unsigned long lastFirebaseSync = 0;
unsigned long lastFirebaseHistory = 0;

float currentAirTemp = 24.0, currentAirHum = 50.0, currentSoilTemp = 20.0;
int currentSoilMoisture = 50, currentLight = 0;

bool isPumping = false;
bool isHeating = false;
bool isLightsOn = false;

bool manualPumpOverride = false;
bool manualHeaterOverride = false;
bool manualLightOverride = false;

unsigned long darkStartTime = 0;
unsigned long lightStartTime = 0;

float targetAirTempMin = 17.0;       
float targetAirTempMax = 30.0;
int targetSoilMoistMin = 30;
int targetSoilMoistMax = 60;
int targetLightDark = 1000;
int targetLightSun = 3000;
unsigned long lastConfigSync = 0;

void streamCallback(FirebaseStream data) {
    String path = data.dataPath();
    if (path == "" || path == "/") return; 

    Serial.printf("Actuator trigger received from Cloud: %s -> %s\n", path.c_str(), data.stringData().c_str());
    String stateStr = data.stringData();
    bool turnOn = (stateStr == "ON");

    if (path == "/pump") {
        manualPumpOverride = true;
        isPumping = turnOn;
        digitalWrite(PUMP_PIN, turnOn ? HIGH : LOW);
        Serial.println("Manual: Pump Override Triggered.");
    }
    else if (path == "/light") {
        manualLightOverride = true;
        isLightsOn = turnOn;
        Serial.println("Manual: Light Override Triggered.");
        if(turnOn) {
            ledcWrite(PWM_RED, 255);   
            ledcWrite(PWM_BLUE, 255); 
            ledcWrite(PWM_WHITE, 255);
            darkStartTime = 0; 
            lightStartTime = 0;
        } else {
            ledcWrite(PWM_RED, 0);
            ledcWrite(PWM_BLUE, 0);
            ledcWrite(PWM_WHITE, 0);
            darkStartTime = 0;
            lightStartTime = 0;
        }
    }
    else if (path == "/heater") {
        manualHeaterOverride = true;
        isHeating = turnOn;
        digitalWrite(HEATER_PIN, turnOn ? HIGH : LOW);
        Serial.println("Manual: Heater Override Triggered.");
    }
    else if (path == "/fan") {
        digitalWrite(FAN_PIN, turnOn ? HIGH : LOW);
    }
}

void streamTimeoutCallback(bool timeout) {
    if (timeout) Serial.println("Firebase stream timeout. Reconnecting...");
}

void applyAutomation() {

    if (!manualHeaterOverride) {
        if (currentAirTemp < targetAirTempMin) {
            if (!isHeating) {
                isHeating = true;
                digitalWrite(HEATER_PIN, HIGH);
                Serial.println("Auto: Heater ON (Temp < targetAirTempMin)");
            }
        } else if (currentAirTemp >= targetAirTempMax) {
            if (isHeating) {
                isHeating = false;
                digitalWrite(HEATER_PIN, LOW);
                Serial.println("Auto: Heater OFF (Temp >= targetAirTempMax)");
            }
        }
    }

    struct tm timeinfo;
    bool timeValid = getLocalTime(&timeinfo);
    bool inRestrictedWaitTime = false;

    if (timeValid && timeinfo.tm_year > 120) {
        int hour = timeinfo.tm_hour;
        if (hour >= 11 && hour < 14) {
            inRestrictedWaitTime = true;
        }
    }

    if (manualPumpOverride) {

        if (currentSoilMoisture > 90 && isPumping) {
            isPumping = false;
            digitalWrite(PUMP_PIN, LOW);
            manualPumpOverride = false; 
            Firebase.RTDB.setString(&fbdo, "/controls/pump", "OFF");
            Serial.println("Safety: Pump FORCED OFF (Moisture > 90%) - Resuming Auto");
        }
    } else {
        if (currentSoilMoisture < targetSoilMoistMin) {
            if (!isPumping && !inRestrictedWaitTime) {
                isPumping = true;
                digitalWrite(PUMP_PIN, HIGH);
                Serial.println("Auto: Pump ON (Moisture < targetSoilMoistMin)");
            } else if (inRestrictedWaitTime && !isPumping) {

            }
        } else if (currentSoilMoisture >= targetSoilMoistMax) {
            if (isPumping) {
                isPumping = false;
                digitalWrite(PUMP_PIN, LOW);
                Serial.println("Auto: Pump OFF (Moisture >= targetSoilMoistMax)");
            }
        }

        if (currentSoilMoisture > 90 && isPumping) {
            isPumping = false;
            digitalWrite(PUMP_PIN, LOW);
            Serial.println("Safety: Auto Pump FORCED OFF (Moisture > 90% absolute limit)");
        }

        if (inRestrictedWaitTime && isPumping) {
            isPumping = false;
            digitalWrite(PUMP_PIN, LOW);
            Serial.println("Auto: Pump FORCED OFF (Entering Restricted Time 11-14)");
        }
    }

    if (!manualLightOverride) {
        if (!isLightsOn) {
        if (currentLight < targetLightDark) {
            if (darkStartTime == 0) darkStartTime = millis(); 
            else if (millis() - darkStartTime >= 1800000) { 
                isLightsOn = true;
                ledcWrite(PWM_RED, 255);
                ledcWrite(PWM_BLUE, 255);
                ledcWrite(PWM_WHITE, 255);
                Serial.println("Auto: Lights ON (Dark for 30m)");
                darkStartTime = 0; 
                lightStartTime = 0;
            }
        } else {
            darkStartTime = 0; 
        }
    } 
    else {
        if (currentLight > targetLightSun) {
            if (lightStartTime == 0) lightStartTime = millis(); 
            else if (millis() - lightStartTime >= 900000) { 
                isLightsOn = false;
                ledcWrite(PWM_RED, 0);
                ledcWrite(PWM_BLUE, 0);
                ledcWrite(PWM_WHITE, 0);
                Serial.println("Auto: Lights OFF (Sunny for 15m)");
                lightStartTime = 0;
                darkStartTime = 0;
            }
        } else {
            lightStartTime = 0; 
        }
    }
}
}

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n--- Starting Smart Agri-Core ---");

    pinMode(FAN_PIN, OUTPUT);     digitalWrite(FAN_PIN, LOW);
    pinMode(PUMP_PIN, OUTPUT);    digitalWrite(PUMP_PIN, LOW);
    pinMode(HEATER_PIN, OUTPUT);  digitalWrite(HEATER_PIN, LOW);
    pinMode(BUZZER_PIN, OUTPUT);  digitalWrite(BUZZER_PIN, LOW);

    ledcAttach(PWM_RED, PWM_FREQ, PWM_RES);
    ledcAttach(PWM_WHITE, PWM_FREQ, PWM_RES);
    ledcAttach(PWM_BLUE, PWM_FREQ, PWM_RES);

    ledcWrite(PWM_RED, 0);
    ledcWrite(PWM_WHITE, 0);
    ledcWrite(PWM_BLUE, 0);

    initSensors();
    Serial.println("=== SYSTEM TEST START ===");

    preferences.begin("agri-config", false);
    String storedSSID = preferences.getString("ssid", "");
    String storedPass = preferences.getString("pass", "");

    bool usingCustomWiFi = false;

    if (storedSSID.length() > 0) {
        Serial.println("Found custom WiFi in Preferences!");
        activeSSID = storedSSID;
        activePass = storedPass;
        usingCustomWiFi = true;
    }

    WiFi.mode(WIFI_STA);
    WiFi.begin(activeSSID.c_str(), activePass.c_str());
    Serial.print("Connecting to WiFi: ");
    Serial.println(activeSSID);

    unsigned long startAttemptTime = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startAttemptTime < 15000) {
        delay(500);
        Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi Connected! IP Address: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("\nWiFi Timeout!");
        if (usingCustomWiFi) {
            Serial.println("Custom WiFi failed! Wiping custom credentials and falling back to default next boot.");
            preferences.remove("ssid");
            preferences.remove("pass");
            preferences.end();
            delay(1000);
            ESP.restart(); 
        } else {
            Serial.println("Booting in Local Mode. Background reconnect enabled.");
        }
    }

    WiFi.setAutoReconnect(true);

    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
    struct tm timeinfo;
    if(getLocalTime(&timeinfo, 10000)) {
        Serial.println("Time synchronized via NTP.");
    } else {
        Serial.println("NTP Time sync failed.");
    }

    fbConfig.api_key = FIREBASE_API_KEY;
    fbConfig.database_url = FIREBASE_URL;

    // Bypass authentication for public databases (avoids token generation entirely)
    fbConfig.signer.test_mode = true;

    Serial.print("Connecting to Firebase...");
    Firebase.begin(&fbConfig, &auth);
    Firebase.reconnectWiFi(true);
    
    Serial.println(" OK");

    if (Firebase.RTDB.getString(&fbdo, "/controls/pump")) {
        bool t = (fbdo.stringData() == "ON"); manualPumpOverride=true; isPumping=t; digitalWrite(PUMP_PIN, t?HIGH:LOW);
    }
    if (Firebase.RTDB.getString(&fbdo, "/controls/heater")) {
        bool t = (fbdo.stringData() == "ON"); manualHeaterOverride=true; isHeating=t; digitalWrite(HEATER_PIN, t?HIGH:LOW);
    }
    if (Firebase.RTDB.getString(&fbdo, "/controls/light")) {
        bool t = (fbdo.stringData() == "ON"); manualLightOverride=true; isLightsOn=t; 
        if(t) { ledcWrite(PWM_RED,255); ledcWrite(PWM_BLUE,255); ledcWrite(PWM_WHITE,255); darkStartTime=0; lightStartTime=0; }
    }

    if (!Firebase.RTDB.beginStream(&stream, "/controls")) {
        Serial.printf("GCP Stream Error: %s\n", stream.errorReason().c_str());
    }
    Firebase.RTDB.setStreamCallback(&stream, streamCallback, streamTimeoutCallback);
}

void loop() {
    unsigned long currentMillis = millis();

    static unsigned long lastWifiAttempt = 0;
    if (WiFi.status() != WL_CONNECTED && (currentMillis - lastWifiAttempt >= 20000)) {
        lastWifiAttempt = currentMillis;
        Serial.println("Offline: Attempting to reconnect to WiFi...");
        WiFi.disconnect();
        WiFi.begin(activeSSID.c_str(), activePass.c_str());
    }

    if (currentMillis - lastSensorRead >= SENSOR_READ_INTERVAL_MS) {
        lastSensorRead = currentMillis;
        readSensors(currentAirTemp, currentAirHum, currentSoilTemp, currentSoilMoisture, currentLight);
        
        Serial.printf("[SENSOR DATA] Air Temp: %.1fC | Air Hum: %.1f%% | Soil Temp: %.1fC | Soil Moist: %d%% | Light: %d\n", 
                      currentAirTemp, currentAirHum, currentSoilTemp, currentSoilMoisture, currentLight);
                      
        applyAutomation();
    }

    if (currentMillis - lastFirebaseSync >= FIREBASE_SYNC_INTERVAL_MS) {
        lastFirebaseSync = currentMillis;

        if (WiFi.status() == WL_CONNECTED && Firebase.ready()) {
            FirebaseJson json;
            json.set("airTemp", currentAirTemp);
            json.set("airHum", currentAirHum);
            json.set("soilTemp", currentSoilTemp);
            json.set("soilMoist", currentSoilMoisture);
            json.set("light", currentLight);
            Firebase.RTDB.setJSON(&fbdo, "/telemetry", &json);
        } else {
            if (WiFi.status() != WL_CONNECTED) {
                Serial.println("Offline: WiFi Disconnected. Telemetry dropped.");
            } else {
                Serial.println("Offline: Connected to WiFi, but Firebase is not ready. Telemetry dropped.");
            }
        }
    }

    if (currentMillis - lastFirebaseHistory >= FIREBASE_HISTORY_INTERVAL_MS) {
        lastFirebaseHistory = currentMillis;

        if (WiFi.status() == WL_CONNECTED && Firebase.ready()) {
            FirebaseJson json;
            json.set("timestamp", String(currentMillis));
            json.set("airTemp", currentAirTemp);
            json.set("soilMoist", currentSoilMoisture);

            Firebase.RTDB.pushJSON(&fbdo, "/history", &json);
            Serial.println("Permanent History Saved to Firebase!");
        }
    }

    if (currentMillis - lastConfigSync >= 30000) {
        lastConfigSync = currentMillis;
        if (WiFi.status() == WL_CONNECTED && Firebase.ready()) {
            if (Firebase.RTDB.getJSON(&fbdo, "/config")) {
                FirebaseJson& json = fbdo.jsonObject();
                FirebaseJsonData result;

                if (json.get(result, "airTempMin")) targetAirTempMin = result.floatValue;
                if (json.get(result, "airTempMax")) targetAirTempMax = result.floatValue;
                if (json.get(result, "soilMoistMin")) targetSoilMoistMin = result.intValue;
                if (json.get(result, "soilMoistMax")) targetSoilMoistMax = result.intValue;
                if (json.get(result, "lightDarkThreshold")) targetLightDark = result.intValue;
                if (json.get(result, "lightSunlightThreshold")) targetLightSun = result.intValue;

                Serial.println("System Config synced from Cloud.");
            }

            if (Firebase.RTDB.getJSON(&fbdo, "/wifi")) {
                FirebaseJson& wifiJson = fbdo.jsonObject();
                FirebaseJsonData resultSsid, resultPass;
                if (wifiJson.get(resultSsid, "ssid") && wifiJson.get(resultPass, "password")) {
                    String newSsid = resultSsid.stringValue;
                    String newPass = resultPass.stringValue;

                    if (newSsid.length() > 0) {
                        Serial.println("New WiFi config detected! Saving to Preferences...");
                        preferences.begin("agri-config", false);
                        preferences.putString("ssid", newSsid);
                        preferences.putString("pass", newPass);
                        preferences.end();

                        Firebase.RTDB.deleteNode(&fbdo, "/wifi");

                        Serial.println("Rebooting to apply new WiFi settings...");
                        delay(2000);
                        ESP.restart();
                    }
                }
            }
        }
    }

    static unsigned long lastHeartbeat = 0;
    if (currentMillis - lastHeartbeat >= 10000) {
        lastHeartbeat = currentMillis;
        if (WiFi.status() == WL_CONNECTED && Firebase.ready()) {
            time_t now;
            time(&now);
            if (now > 100000) { 
                double timestampMs = (double)now * 1000.0;
                Firebase.RTDB.setDouble(&fbdo, "/esp_status/last_seen", timestampMs);
            }
        }
    }
}
