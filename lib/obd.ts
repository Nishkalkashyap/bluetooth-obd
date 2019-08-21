const EventEmitter = require('events').EventEmitter;
import BSP from 'bluetooth-serial-port';

import PIDS from './obdInfo';

const writeDelay = 50;

/**
 * Queue for writing
 * @type {Array}
 */
const queue: Array<any> = [];

export class OBDReader extends EventEmitter {
    connected: boolean = false;
    receivedData = '';
    protocol = '0';
    btSerial: BSP.BluetoothSerialPort

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

    /**
     * Attempts discovery of and subsequent connection to Bluetooth device and channel
     * @param {string} query Query string to be fuzzy-ish matched against device name/address
     */
    autoconnect(query: string) {
        const self = this; //Enclosure
        const btSerial = new BSP.BluetoothSerialPort();
        const search = new RegExp(query.replace(/\W/g, ''), 'gi');

        btSerial.on('found', (address: string, name: string) => {
            const addrMatch = !query || address.replace(/\W/g, '').search(search) != -1;
            const nameMatch = !query || name.replace(/\W/g, '').search(search) != -1;

            if (addrMatch || nameMatch) {
                btSerial.removeAllListeners('finished');
                btSerial.removeAllListeners('found');
                self.emit('debug', 'Found device: ' + name + ' (' + address + ')');

                btSerial.findSerialPortChannel(address, function (channel) {
                    self.emit('debug', 'Found device channel: ' + channel);
                    self.connect(address, channel);
                }, () => {
                    console.log("Error finding serialport: ");
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


    connect(address: string, channel: number) {
        // const self = this; //Enclosure
        const btSerial = new BSP.BluetoothSerialPort();

        this.btSerial.connect(address, channel, () => {
            this.connected = true;

            this.write('ATZ');
            //Turns off extra line feed and carriage return
            this.write('ATL0');
            //This disables spaces in in output, which is faster!
            this.write('ATS0');
            //Turns off headers and checksum to be sent.
            this.write('ATH0');
            //Turns off echo.
            this.write('ATE0');
            //Turn adaptive timing to 2. This is an aggressive learn curve for adjusting the timeout. Will make huge difference on slow systems.
            this.write('ATAT2');
            //Set timeout to 10 * 4 = 40msec, allows +20 queries per second. This is the maximum wait-time. ATAT will decide if it should wait shorter or not.
            //self.write('ATST0A');
            //http://www.obdtester.com/elm-usb-commands
            this.write('ATSP' + this.protocol);

            //Event connected
            this.emit('connected');

            this.btSerial.on('data', (data) => {
                let currentString, arrayOfCommands;
                currentString = this.receivedData + data.toString('utf8'); // making sure it's a utf8 string

                arrayOfCommands = currentString.split('>');

                let forString = '';
                if (arrayOfCommands.length < 2) {
                    this.receivedData = arrayOfCommands[0];
                } else {
                    for (let commandNumber = 0; commandNumber < arrayOfCommands.length; commandNumber++) {
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
                            this.emit('dataReceived', reply);
                            this.receivedData = '';
                        }
                    }
                }
            });

            btSerial.on('failure', (error: any) => {
                this.emit('error', 'Error with OBD-II device: ' + error);
            });

        }, function (err) { //Error callback!
            this.emit('error', 'Error with OBD-II device: ' + err);
        });

        this.btSerial = btSerial; //Save the connection in OBDReader object.

        this.intervalWriter = setInterval(() => {
            if (queue.length > 0 && this.connected)
                try {
                    this.btSerial.write(new Buffer(queue.shift(), "utf-8"), (err) => {
                        if (err) {
                            this.emit('error', err);
                        }
                    });
                } catch (err) {
                    this.emit('error', 'Error while writing: ' + err);
                    this.emit('error', 'OBD-II Listeners deactivated, connection is probably lost.');
                    clearInterval(this.intervalWriter);
                    this.removeAllPollers();
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
    disconnect(cb: Function) {
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
    write(message: string, replies?: number) {
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
    requestValueByName(name: string) {
        this.write(getPIDByName(name));
    };

    activePollers: string[] = [];

    /**
     * Adds a poller to the poller-array.
     * @this {OBDReader}
     * @param {string} name Name of the poller you want to add.
     */
    addPoller(name: string) {
        const stringToSend = getPIDByName(name);
        this.activePollers.push(stringToSend);
    };

    /**
     * Removes an poller.
     * @this {OBDReader}
     * @param {string} name Name of the poller you want to remove.
     */
    removePoller(name: string) {
        const stringToDelete = getPIDByName(name);
        const index = this.activePollers.indexOf(stringToDelete);
        this.activePollers.splice(index, 1);
    };

    /**
     * Removes all pollers.
     * @this {OBDReader}
     */
    removeAllPollers() {
        this.activePollers.length = 0; //This does not delete the array, it just clears every element.
    };

    /**
     * Writes all active pollers.
     * @this {OBDReader}
     */
    writePollers() {
        let i: number;
        for (i = 0; i < this.activePollers.length; i++) {
            this.write(this.activePollers[i], 1);
        }
    };

    pollerInterval: number;
    /**
     * Starts polling. Lower interval than activePollers * 50 will probably give buffer overflows. See writeDelay.
     * @this {OBDReader}
     * @param {number} interval Frequency how often all variables should be polled. (in ms). If no value is given, then for each activePoller 75ms will be added.
     */
    startPolling(interval: number) {
        if (interval === undefined) {
            interval = this.activePollers.length * (writeDelay * 2); //Double the delay, so there's room for manual requests.
        }

        this.pollerInterval = setInterval(() => {
            this.writePollers();
        }, interval) as any as number;
    };

    /**
     * Stops polling.
     * @this {OBDReader}
     */
    stopPolling() {
        clearInterval(this.pollerInterval);
    };


}

// util.inherits(OBDReader, EventEmitter);

/**
 * Find a PID-value by name.
 * @param name Name of the PID you want the hexadecimal (in ASCII text) value of.
 * @return {string} PID in hexadecimal ASCII
 */
function getPIDByName(name: string): string {
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
function parseOBDCommand(hexString: string): object {
    const byteNumber,
        valueArray; //New object

    const reply = {};
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