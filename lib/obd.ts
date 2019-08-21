const EventEmitter = require('events').EventEmitter;
import util from 'util';

import PIDS from './obdInfo';

const writeDelay = 50;

/**
 * Queue for writing
 * @type {Array}
 */
const queue = [];

export class OBDReader extends EventEmitter {
    connected: boolean = false;
    receivedData = '';
    protocol = '0';

    /**
     * Set the protocol version number to use with your car.  Defaults to 0
     * which is to autoselect.
     *
     * Uses the ATSP command - see http://www.obdtester.com/elm-usb-commands
     *
     * @default 0
     * 
     */
    setProtocol(protocol: string) {
        if (protocol.toString().search(/^[0-9]$/) === -1) {
            throw "setProtocol: Must provide a number between 0 and 9 - refer to ATSP section of http://www.obdtester.com/elm-usb-commands";
        }
        this.protocol = protocol;
    }

/**
 * Get the protocol version number set for this object.  Defaults to 0
 * which is to autoselect.
 *
 * Uses the ATSP command - see http://www.obdtester.com/elm-usb-commands
 *
 */
    getProtocol() {
        return this.protocol;
    }
}

// util.inherits(OBDReader, EventEmitter);

/**
 * Find a PID-value by name.
 * @param name Name of the PID you want the hexadecimal (in ASCII text) value of.
 * @return {string} PID in hexadecimal ASCII
 */
function getPIDByName(name) {
    let i: number;
    for (i = 0; i < PIDS.length; i++) {
        if (PIDS[i].name === name) {
            if (PIDS[i].pid !== undefined) {
                return (PIDS[i].mode + PIDS[i].pid);
            }
            //There are modes which don't require a extra parameter ID.
            return (PIDS[i].mode);
        }
    }
}

/**
 * Parses a hexadecimal string to a reply object. Uses PIDS. (obdInfo.js)
 * @param {string} hexString Hexadecimal value in string that is received over the serialport.
 * @return {Object} reply - The reply.
 * @return {string} reply.value - The value that is already converted. This can be a PID converted answer or "OK" or "NO DATA".
 * @return {string} reply.name - The name. --! Only if the reply is a PID.
 * @return {string} reply.mode - The mode of the PID. --! Only if the reply is a PID.
 * @return {string} reply.pid - The PID. --! Only if the reply is a PID.
 */
function parseOBDCommand(hexString) {
    const reply,
        byteNumber,
        valueArray; //New object

    reply = {};
    if (hexString === "NO DATA" || hexString === "OK" || hexString === "?" || hexString === "UNABLE TO CONNECT" || hexString === "SEARCHING...") {
        //No data or OK is the response, return directly.
        reply.value = hexString;
        return reply;
    }

    hexString = hexString.replace(/ /g, ''); //Whitespace trimming //Probably not needed anymore?
    valueArray = [];

    for (byteNumber = 0; byteNumber < hexString.length; byteNumber += 2) {
        valueArray.push(hexString.substr(byteNumber, 2));
    }

    if (valueArray[0] === "41") {
        reply.mode = valueArray[0];
        reply.pid = valueArray[1];
        for (const i = 0; i < PIDS.length; i++) {
            if (PIDS[i].pid == reply.pid) {
                const numberOfBytes = PIDS[i].bytes;
                reply.name = PIDS[i].name;
                switch (numberOfBytes) {
                    case 1:
                        reply.value = PIDS[i].convertToUseful(valueArray[2]);
                        break;
                    case 2:
                        reply.value = PIDS[i].convertToUseful(valueArray[2], valueArray[3]);
                        break;
                    case 4:
                        reply.value = PIDS[i].convertToUseful(valueArray[2], valueArray[3], valueArray[4], valueArray[5]);
                        break;
                    case 8:
                        reply.value = PIDS[i].convertToUseful(valueArray[2], valueArray[3], valueArray[4], valueArray[5], valueArray[6], valueArray[7], valueArray[8], valueArray[9]);
                        break;
                }
                break; //Value is converted, break out the for loop.
            }
        }
    } else if (valueArray[0] === "43") {
        reply.mode = valueArray[0];
        for (let i = 0; i < PIDS.length; i++) {
            if (PIDS[i].mode == "03") {
                reply.name = PIDS[i].name;
                reply.value = PIDS[i].convertToUseful(valueArray[1], valueArray[2], valueArray[3], valueArray[4], valueArray[5], valueArray[6]);
            }
        }
    }
    return reply;
}

/**
 * Attempts discovery of and subsequent connection to Bluetooth device and channel
 * @param {string} query Query string to be fuzzy-ish matched against device name/address
 */
OBDReader.prototype.autoconnect = function (query: string) {
    const self = this; //Enclosure
    const btSerial = new (require('bluetooth-serial-port')).BluetoothSerialPort();
    const search = new RegExp(query.replace(/\W/g, ''), 'gi');

    btSerial.on('found', function (address, name) {
        const addrMatch = !query || address.replace(/\W/g, '').search(search) != -1;
        const nameMatch = !query || name.replace(/\W/g, '').search(search) != -1;

        if (addrMatch || nameMatch) {
            btSerial.removeAllListeners('finished');
            btSerial.removeAllListeners('found');
            self.emit('debug', 'Found device: ' + name + ' (' + address + ')');

            btSerial.findSerialPortChannel(address, function (channel) {
                self.emit('debug', 'Found device channel: ' + channel);
                self.connect(address, channel);
            }, function (err) {
                console.log("Error finding serialport: " + err);
            });
        } else {
            self.emit('debug', 'Ignoring device: ' + name + ' (' + address + ')');
        }
    });

    btSerial.on('finished', function () {
        self.emit('error', 'No suitable devices found');
    });

    btSerial.inquire();
}

OBDReader.prototype.connect = function (address, channel) {
    const self = this; //Enclosure
    const btSerial = new (require('bluetooth-serial-port')).BluetoothSerialPort();

    btSerial.connect(address, channel, function () {
        self.connected = true;

        self.write('ATZ');
        //Turns off extra line feed and carriage return
        self.write('ATL0');
        //This disables spaces in in output, which is faster!
        self.write('ATS0');
        //Turns off headers and checksum to be sent.
        self.write('ATH0');
        //Turns off echo.
        self.write('ATE0');
        //Turn adaptive timing to 2. This is an aggressive learn curve for adjusting the timeout. Will make huge difference on slow systems.
        self.write('ATAT2');
        //Set timeout to 10 * 4 = 40msec, allows +20 queries per second. This is the maximum wait-time. ATAT will decide if it should wait shorter or not.
        //self.write('ATST0A');
        //http://www.obdtester.com/elm-usb-commands
        self.write('ATSP' + self.protocol);

        //Event connected
        self.emit('connected');

        btSerial.on('data', function (data) {
            const currentString, arrayOfCommands;
            currentString = self.receivedData + data.toString('utf8'); // making sure it's a utf8 string

            arrayOfCommands = currentString.split('>');

            let forString = '';
            if (arrayOfCommands.length < 2) {
                self.receivedData = arrayOfCommands[0];
            } else {
                for (const commandNumber = 0; commandNumber < arrayOfCommands.length; commandNumber++) {
                    forString = arrayOfCommands[commandNumber];
                    if (forString === '') {
                        continue;
                    }

                    const multipleMessages = forString.split('\r');
                    for (let messageNumber = 0; messageNumber < multipleMessages.length; messageNumber++) {
                        const messageString = multipleMessages[messageNumber];
                        if (messageString === '') {
                            continue;
                        }
                        const reply = parseOBDCommand(messageString);
                        //Event dataReceived.
                        self.emit('dataReceived', reply);
                        self.receivedData = '';
                    }
                }
            }
        });

        btSerial.on('failure', function (error) {
            self.emit('error', 'Error with OBD-II device: ' + error);
        });

    }, function (err) { //Error callback!
        self.emit('error', 'Error with OBD-II device: ' + err);
    });

    this.btSerial = btSerial; //Save the connection in OBDReader object.

    this.intervalWriter = setInterval(function () {
        if (queue.length > 0 && self.connected)
            try {
                self.btSerial.write(new Buffer(queue.shift(), "utf-8"), function (err, count) {
                    if (err)
                        self.emit('error', err);
                });
            } catch (err) {
                self.emit('error', 'Error while writing: ' + err);
                self.emit('error', 'OBD-II Listeners deactivated, connection is probably lost.');
                clearInterval(self.intervalWriter);
                self.removeAllPollers();
            }
    }, writeDelay); //Updated with Adaptive Timing on ELM327. 20 queries a second seems good enough.

    return this;
};

/**
 * Disconnects/closes the port.
 *
 * @param {Function} cb Callback function when the serial connection is closed
 * @this {OBDReader}
 */
OBDReader.prototype.disconnect = function (cb) {
    clearInterval(this.intervalWriter);
    queue.length = 0; //Clears queue
    if (typeof cb === 'function') {
        this.btSerial.on('closed', cb);
    }
    this.btSerial.close();
    this.connected = false;
};

/**
 * Writes a message to the port. (Queued!) All write functions call this function.
 * @this {OBDReader}
 * @param {string} message The PID or AT Command you want to send. Without \r or \n!
 * @param {number} replies The number of replies that are expected. Default = 0. 0 --> infinite
 * AT Messages --> Zero replies!!
 */
OBDReader.prototype.write = function (message, replies) {
    if (replies === undefined) {
        replies = 0;
    }
    if (this.connected) {
        if (queue.length < 256) {
            if (replies !== 0) {
                queue.push(message + replies + '\r');
            } else {
                queue.push(message + '\r');
            }
        } else {
            this.emit('error', 'Queue-overflow!');
        }
    } else {
        this.emit('error', 'Bluetooth device is not connected.');
    }
};
/**
 * Writes a PID value by entering a pid supported name.
 * @this {OBDReader}
 * @param {string} name Look into obdInfo.js for all PIDS.
 */
OBDReader.prototype.requestValueByName = function (name) {
    this.write(getPIDByName(name));
};

const activePollers = [];
/**
 * Adds a poller to the poller-array.
 * @this {OBDReader}
 * @param {string} name Name of the poller you want to add.
 */
OBDReader.prototype.addPoller = function (name) {
    const stringToSend = getPIDByName(name);
    activePollers.push(stringToSend);
};
/**
 * Removes an poller.
 * @this {OBDReader}
 * @param {string} name Name of the poller you want to remove.
 */
OBDReader.prototype.removePoller = function (name) {
    const stringToDelete = getPIDByName(name);
    const index = activePollers.indexOf(stringToDelete);
    activePollers.splice(index, 1);
};
/**
 * Removes all pollers.
 * @this {OBDReader}
 */
OBDReader.prototype.removeAllPollers = function () {
    activePollers.length = 0; //This does not delete the array, it just clears every element.
};
/**
 * Writes all active pollers.
 * @this {OBDReader}
 */
OBDReader.prototype.writePollers = function () {
    const i;
    for (i = 0; i < activePollers.length; i++) {
        this.write(activePollers[i], 1);
    }
};

const pollerInterval;
/**
 * Starts polling. Lower interval than activePollers * 50 will probably give buffer overflows. See writeDelay.
 * @this {OBDReader}
 * @param {number} interval Frequency how often all variables should be polled. (in ms). If no value is given, then for each activePoller 75ms will be added.
 */
OBDReader.prototype.startPolling = function (interval) {
    if (interval === undefined) {
        interval = activePollers.length * (writeDelay * 2); //Double the delay, so there's room for manual requests.
    }

    const self = this;
    pollerInterval = setInterval(function () {
        self.writePollers();
    }, interval);
};
/**
 * Stops polling.
 * @this {OBDReader}
 */
OBDReader.prototype.stopPolling = function () {
    clearInterval(pollerInterval);
};