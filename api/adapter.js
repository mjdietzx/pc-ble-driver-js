/* Copyright (c) 2016, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 *   1. Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 *
 *   2. Redistributions in binary form, except as embedded into a Nordic
 *   Semiconductor ASA integrated circuit in a product or a software update for
 *   such product, must reproduce the above copyright notice, this list of
 *   conditions and the following disclaimer in the documentation and/or other
 *   materials provided with the distribution.
 *
 *   3. Neither the name of Nordic Semiconductor ASA nor the names of its
 *   contributors may be used to endorse or promote products derived from this
 *   software without specific prior written permission.
 *
 *   4. This software, with or without modification, must only be used with a
 *   Nordic Semiconductor ASA integrated circuit.
 *
 *   5. Any software provided in binary form under this license must not be
 *   reverse engineered, decompiled, modified and/or disassembled.
 *
 *
 * THIS SOFTWARE IS PROVIDED BY NORDIC SEMICONDUCTOR ASA "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY, NONINFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
 * GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
 * OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

'use strict';

const EventEmitter = require('events');
const _ = require('underscore');

const AdapterState = require('./adapterState');
const Characteristic = require('./characteristic');
const Descriptor = require('./descriptor');
const Device = require('./device');
const Security = require('./security');
const Service = require('./service');

const AdType = require('./util/adType');
const Converter = require('./util/sdConv');
const HexConv = require('./util/hexConv');
const logLevel = require('./util/logLevel');
const ToText = require('./util/toText');

/** Class to mediate error conditions. */
class Error {
    /**
     * Create an error object.
     *
     * @constructor
     * @param {string} userMessage The message to display to the user.
     * @param {string} description A detailed description of the error.
     */
    constructor(userMessage, description) {
        description = typeof description !== 'undefined' ? description : '';

        this.message = userMessage;
        this.description = description;
    }
}

const _makeError = (userMessage, description) => new Error(userMessage, description);
const _isCallback = callback => callback && (typeof callback === 'function');

/**
 * Class representing a transport adapter (SoftDevice RPC module).
 */
class Adapter extends EventEmitter {
    /**
     * @summary Create an object representing an adapter.
     *
     * This constructor is called by `AdapterFactory` and it should not be necessary for the developer to call directly.
     *
     * @constructor
     * @param {Object} bleDriver The driver to use for getting constants from the pc-ble-driver-js AddOn.
     * @param {Object} adapter The adapter to use. The adapter is an object received from the pc-ble-driver-js AddOn.
     * @param {string} instanceId The unique Id that identifies this Adapter instance.
     * @param {string} port The port this adapter uses. For example it can be 'COM1', '/dev/ttyUSB0' or similar.
     * @param {string} serialNumber The serial number of hardware device this adapter is controlling via serial.
     * @param {string} notSupportedMessage Message displayed to developer if this adapter is not supported on platform.
     *
     * @fires {} Emits events. TODO
     * @throws {Error} Thrown when an error occurs.
     */
    constructor(bleDriver, adapter, instanceId, port, serialNumber, notSupportedMessage) {
        super();

        if (adapter === undefined) {
            throw _makeError('Missing argument adapter.');
        }
        if (bleDriver === undefined) {
            throw _makeError('Missing argument bleDriver.');
        }
        if (instanceId === undefined) {
            throw _makeError('Missing argument instanceId.');
        }
        if (port === undefined) {
            throw _makeError('Missing argument port.');
        }

        this._adapter = adapter;
        this._bleDriver = bleDriver;
        this._instanceId = instanceId;
        this._notSupportedMessage = notSupportedMessage;

        this._state = new AdapterState(instanceId, port, serialNumber);
        this._security = new Security(this._bleDriver);

        this._keys = null;
        this._attMtuMap = {};

        this._init();
    }

    _init() {
        this._devices = {};
        this._services = {};
        this._characteristics = {};
        this._descriptors = {};

        this._converter = new Converter(this._bleDriver, this._adapter);

        this._gapOperationsMap = {};
        this._gattOperationsMap = {};

        this._preparedWritesMap = {};

        this._pendingNotificationsAndIndications = {};

        this._defaultAdapterOpenOptions = {
            baudRate: 115200,
            parity: 'none',
            flowControl: 'none',
            eventInterval: 0,
            logLevel: 'info',
            retransmissionInterval: 100,
            responseTimeout: 750,
            enableBLE: true,
        };

        this._defaultBleOptions = {
            gap_enable_params: {
                periph_conn_count: 1,
                central_conn_count: 7,
                central_sec_count: 1,
            },
            gatts_enable_params: {
                service_changed: false,
                attr_tab_size: this._bleDriver.BLE_GATTS_ATTR_TAB_SIZE_DEFAULT,
            },
            common_enable_params: {
                conn_bw_counts: null, // tell SoftDevice to use default
                vs_uuid_count: 10,
            },
            gatt_enable_params: {
                att_mtu: 247, // 247 is max att mtu size
            },
        };
    }

    _emitError(err, userMessage) {
        const error = _makeError(userMessage, err);
        this.emit('error', error);
    }

    // returns `true` if an error occurred, `false` otherwise
    _checkAndPropagateError(err, userMessage, callback) {
        if (err) {
            this._emitError(err, userMessage);
            if (_isCallback(callback)) {
                callback(err);
            }
        }

        return (err && typeof err !== 'undefined');
    }

    _getDeviceByIdAndPropagateError(deviceInstanceId, errorStr, callback) {
        const device = this.getDevice(deviceInstanceId);

        if (!device) {
            const error = _makeError(errorStr, `Failed to find device with Id: ${deviceInstanceId}.`);

            this.emit('error', error);
            if (_isCallback(callback)) {
                callback(error);
            }
        }

        return device;
    }

    _changeState(changingStates, swallowEmit) {
        swallowEmit = typeof swallowEmit !== 'undefined' ? swallowEmit : false;
        let changed = false;

        Object.keys(changingStates).forEach(state => {
            const previousValue = this._state[state];
            const newValue = changingStates[state];

            if (!_.isEqual(previousValue, newValue)) {
                this._state[state] = newValue;
                changed = true;
            }
        });

        if (!swallowEmit && changed) {
            this.emit('stateChanged', this._state);
        }
    }

    _getServiceType(service) {
        let type;

        if (service.type) {
            if (service.type === 'primary') {
                type = this._bleDriver.BLE_GATTS_SRVC_TYPE_PRIMARY;
            } else if (service.type === 'secondary') {
                type = this._bleDriver.BLE_GATTS_SRVC_TYPE_SECONDARY;
            } else {
                throw _makeError(`Unknown service type: '${service.type}'. Must be 'primary' or 'secondary'.`);
            }
        } else {
            throw _makeError('Service type is not specified. Must be \'primary\' or \'secondary\'.');
        }

        return type;
    }

    /**
     * Get the instanceId of this adapter.
     * @returns {string} Unique Id of this adapter.
     */
    get instanceId() {
        return this._instanceId;
    }

    /**
     * Get the state of this adapter. @ref: ./adapterState.js
     * @returns {AdapterState} `AdapterState` store object of this adapter.
     */
    get state() {
        return this._state;
    }

    /**
     * Get the driver of this adapter.
     * @returns {Object} The pc-ble-driver to use for this adapter, from the pc-ble-driver-js add-on.
     */
    get driver() {
        return this._bleDriver;
    }

    /**
     * Get the `notSupportedMessage` of this adapter.
     * @returns {string} The error message thrown if this adapter is not supported on the platform/hardware.
     */
    get notSupportedMessage() {
        return this._notSupportedMessage;
    }

    _maxReadPayloadSize(deviceInstanceId) {
        return this.getCurrentAttMtu(deviceInstanceId) - 1;
    }

    _maxShortWritePayloadSize(deviceInstanceId) {
        return this.getCurrentAttMtu(deviceInstanceId) - 3;
    }

    _maxLongWritePayloadSize(deviceInstanceId) {
        return this.getCurrentAttMtu(deviceInstanceId) - 5;
    }

    _generateKeyPair() {
        if (this._keys === null) {
            this._keys = this._security.generateKeyPair();
        }
    }

    /**
     * Compute shared secret.
     *
     * @param {string} peerPublicKey Optional peer public key.
     * @returns {string} The computed shared secret generated from this adapter's key-pair.
     */
    computeSharedSecret(peerPublicKey) {
        this._generateKeyPair();
        const publicKey = typeof peerPublicKey !== 'undefined' ? peerPublicKey : this._keys;
        return this._security.generateSharedSecret(this._keys.sk, publicKey.pk).ss;
    }

    /**
     * Compute public key.
     *
     * @returns {string} The public key generated from this adapter's key-pair.
     */
    computePublicKey() {
        this._generateKeyPair();
        return this._security.generatePublicKey(this._keys.sk).pk;
    }

    /**
     * Sets this adapter's `_keys` property to null. `this._generateKeyPair()` will generate a new key-pair now.
     * @returns {void}
     */
    deleteKeys() {
        this._keys = null;
    }

    /**
     * @summary Initialize the adapter.
     *
     * The serial port will be attempted to be opened with the configured serial port settings in `adapterOptions`.
     * Available adapter open options:
     * - {number} baudRate: The baud rate this adapter's serial port should be configured with.
     * - {string} parity: The parity this adapter's serial port should be configured with.
     * - {string} flowControl: Whether flow control should be configured with this adapter's serial port.
     * - {number} eventInterval: Interval to use for sending BLE driver events to JavaScript.
     *                           If 0 events will be sent as soon as they are received from the BLE driver.
     * - {string} logLevel: The verbosity of logging the developer wants with this adapter.
     * - {number} retransmissionInterval:
     * - {number} responseTimeout: Response timeout of the data link layer.
     * - {boolean} enableBLE: Whether the BLE stack should be initialized and enabled.
     * @param {AdapterOpenOptions} adapterOptions Options to initialize/open this adapter with.
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    open(adapterOptions, callback) {
        adapterOptions = typeof adapterOptions !== 'undefined' ? adapterOptions : this._defaultAdapterOpenOptions;

        if (typeof this.notSupportedMessage !== 'undefined') {
            const error = _makeError(this.notSupportedMessage);
            this.emit('warning', error);
        }

        Object.keys(this._defaultAdapterOpenOptions).forEach(option => {
            if (typeof adapterOptions[option] === 'undefined') {
                adapterOptions[option] = this._defaultAdapterOpenOptions[option];
            }
        });

        this._changeState({
            baudRate: adapterOptions.baudRate,
            parity: adapterOptions.parity,
            flowControl: adapterOptions.flowControl,
        });

        adapterOptions.eventCallback = this._eventCallback.bind(this);
        adapterOptions.logCallback = this._logCallback.bind(this);
        adapterOptions.statusCallback = this._statusCallback.bind(this);

        this._adapter.open(this._state.port, adapterOptions, err => {
            if (this._checkAndPropagateError(err, 'Error occurred opening serial port.', callback)) {
                return;
            }

            this._changeState({ available: true });
            this.emit('opened', this);

            if (adapterOptions.enableBLE) {
                this.getState(getStateError => {
                    if (this._checkAndPropagateError(getStateError, 'Error retrieving adapter state.', callback)) {
                        return;
                    }

                    if (_isCallback(callback)) {
                        callback();
                    }
                });
            } else if (_isCallback(callback)) {
                callback();
            }
        });
    }

    /**
     * @summary Close the adapter.
     *
     * This function will close the serial port, release allocated resources and remove event listeners.
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    close(callback) {
        this._changeState({ available: false });
        this._adapter.close(err => {
            this.emit('closed', this);
            if (_isCallback(callback)) {
                callback(err);
            }
        });
    }

    /**
     * Get this adapters stats.
     * @returns {Object} This adapters stats.
     */
    getStats() {
        return this._adapter.getStats();
    }

    /**
     * @summary Enable the BLE stack
     *
     * This call initializes the BLE stack, no other BLE related function can be called before this one.
     *
     * Available BLE enable parameters:
     * - {Object} gap_enable_params: GAP init parameters
     *                - {number} periph_conn_count: Number of connections acting as a peripheral.
     *                - {number} central_conn_count: Number of connections acting as a central.
     *                - {number} central_sec_count: Number of SMP instances for all connections acting as a central..
     * - {Object} gatts_enable_params: GATTS init parameters
     *                - {boolean} service_changed: Include the Service Changed characteristic in the Attribute Table.
     *                - {number} attr_tab_size: Attribute Table size in bytes. The size must be a multiple of 4.
     * - {Object} common_enable_params: Common init parameters
     *                - {null|number} conn_bw_counts: Bandwidth configuration parameters or null for defaults.
     *                - {number} vs_uuid_count: Maximum number of 128-bit, Vendor Specific UUID bases to allocate.
     * - {Object} gatt_enable_params: GATT init parameters
     *                - {number} att_mtu: Maximum size of ATT packet the SoftDevice can send or receive.
     *                                    If it is 0 then @ref GATT_MTU_SIZE_DEFAULT will be used.
     *                                    Otherwise @ref GATT_MTU_SIZE_DEFAULT is the minimum value.
     * @param {Object} options BLE Initialization parameters.
     *
     * @param {function} callback Callback signature: (err, parameters, app_ram_base) => {}.
     * @returns {void}
     */
    enableBLE(options, callback) {
        options = typeof options !== 'undefined' ? options : this._defaultBleOptions;

        this._adapter.enableBLE(options, (err, parameters, appRamBase) => {
            if (!this._checkAndPropagateError(err, 'Enabling BLE failed.', callback)) {
                if (_isCallback(callback)) {
                    callback(err, parameters, appRamBase);
                }
            }
        });
    }

    _logCallback(severity, message) {
        this.emit('logMessage', severity, message);
    }

    _statusCallback(status) {
        switch (status.id) {
            case this._bleDriver.RESET_PERFORMED:
                this._init();
                this._changeState({ available: false, connecting: false, scanning: false, advertising: false });
                break;
            case this._bleDriver.CONNECTION_ACTIVE:
                this._changeState({ available: true });
                break;
            default:
                this._logCallback('warning', 'Un-known status Id received.');
        }

        this.emit('status', status);
    }

    _eventCallback(eventArray) {
        eventArray.forEach(event => {
            const text = new ToText(event);

            // TODO: set the correct log level for different types of events
            this._logCallback(logLevel.DEBUG, `${text}`);

            switch (event.id) {
                case this._bleDriver.BLE_GAP_EVT_CONNECTED:
                    this._parseConnectedEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_DISCONNECTED:
                    this._parseDisconnectedEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_CONN_PARAM_UPDATE:
                    this._parseConnectionParameterUpdateEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_SEC_REQUEST:
                    this._parseGapSecurityRequestEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_SEC_PARAMS_REQUEST:
                    this._parseSecParamsRequestEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_CONN_SEC_UPDATE:
                    this._parseConnSecUpdateEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_AUTH_STATUS:
                    this._parseAuthStatusEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_PASSKEY_DISPLAY:
                    this._parsePasskeyDisplayEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_AUTH_KEY_REQUEST:
                    this._parseAuthKeyRequest(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_KEY_PRESSED:
                    this._parseGapKeyPressedEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_LESC_DHKEY_REQUEST:
                    this._parseLescDhkeyRequest(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_SEC_INFO_REQUEST:
                    this._parseSecInfoRequest(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_TIMEOUT:
                    this._parseGapTimeoutEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_RSSI_CHANGED:
                    this._parseGapRssiChangedEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_ADV_REPORT:
                    this._parseGapAdvertismentReportEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_CONN_PARAM_UPDATE_REQUEST:
                    this._parseGapConnectionParameterUpdateRequestEvent(event);
                    break;
                case this._bleDriver.BLE_GAP_EVT_SCAN_REQ_REPORT:
                    // Not needed, received when a scan request is received.
                    break;
                case this._bleDriver.BLE_GATTC_EVT_PRIM_SRVC_DISC_RSP:
                    this._parseGattcPrimaryServiceDiscoveryResponseEvent(event);
                    break;
                case this._bleDriver.BLE_GATTC_EVT_REL_DISC_RSP:
                    // Not needed, used for included services discovery.
                    break;
                case this._bleDriver.BLE_GATTC_EVT_CHAR_DISC_RSP:
                    this._parseGattcCharacteristicDiscoveryResponseEvent(event);
                    break;
                case this._bleDriver.BLE_GATTC_EVT_DESC_DISC_RSP:
                    this._parseGattcDescriptorDiscoveryResponseEvent(event);
                    break;
                case this._bleDriver.BLE_GATTC_EVT_CHAR_VAL_BY_UUID_READ_RSP:
                    // Not needed, service discovery is not using the related function.
                    break;
                case this._bleDriver.BLE_GATTC_EVT_READ_RSP:
                    this._parseGattcReadResponseEvent(event);
                    break;
                case this._bleDriver.BLE_GATTC_EVT_CHAR_VALS_READ_RSP:
                    // Not needed, characteristic discovery is not using the related function.
                    break;
                case this._bleDriver.BLE_GATTC_EVT_WRITE_RSP:
                    this._parseGattcWriteResponseEvent(event);
                    break;
                case this._bleDriver.BLE_GATTC_EVT_HVX:
                    this._parseGattcHvxEvent(event);
                    break;
                case this._bleDriver.BLE_GATTC_EVT_TIMEOUT:
                    this._parseGattTimeoutEvent(event);
                    break;
                case this._bleDriver.BLE_GATTC_EVT_EXCHANGE_MTU_RSP:
                    this._parseGattcExchangeMtuResponseEvent(event);
                    break;
                case this._bleDriver.BLE_GATTS_EVT_WRITE:
                    this._parseGattsWriteEvent(event);
                    break;
                case this._bleDriver.BLE_GATTS_EVT_RW_AUTHORIZE_REQUEST:
                    this._parseGattsRWAutorizeRequestEvent(event);
                    break;
                case this._bleDriver.BLE_GATTS_EVT_SYS_ATTR_MISSING:
                    this._parseGattsSysAttrMissingEvent(event);
                    break;
                case this._bleDriver.BLE_GATTS_EVT_HVC:
                    this._parseGattsHvcEvent(event);
                    break;
                case this._bleDriver.BLE_GATTS_EVT_SC_CONFIRM:
                    // Not needed, service changed is not supported currently.
                    break;
                case this._bleDriver.BLE_GATTS_EVT_TIMEOUT:
                    this._parseGattTimeoutEvent(event);
                    break;
                case this._bleDriver.BLE_GATTS_EVT_EXCHANGE_MTU_REQUEST:
                    this._parseGattsExchangeMtuRequestEvent(event);
                    break;
                case this._bleDriver.BLE_EVT_USER_MEM_REQUEST:
                    this._parseMemoryRequestEvent(event);
                    break;
                case this._bleDriver.BLE_EVT_TX_COMPLETE:
                    this._parseTxCompleteEvent(event);
                    break;
                case this._bleDriver.BLE_EVT_DATA_LENGTH_CHANGED:
                    this._parseDataLengthChangedEvent(event);
                    break;
                default:
                    this._logCallback(logLevel.INFO,
                                      `Unsupported event received from the SoftDevice: ${event.id} - ${event.name}`);
            }
        });
    }

    _parseConnectedEvent(event) {
        const deviceAddress = event.peer_addr;
        const connectionParameters = event.conn_params;

        let deviceRole;
        if (event.role === 'BLE_GAP_ROLE_CENTRAL') {
            deviceRole = 'peripheral';
        } else if (event.role === 'BLE_GAP_ROLE_PERIPH') {
            deviceRole = 'central';
        }

        const device = new Device(deviceAddress, deviceRole);
        device.connectionHandle = event.conn_handle;
        device.minConnectionInterval = connectionParameters.min_conn_interval;
        device.maxConnectionInterval = connectionParameters.max_conn_interval;
        device.slaveLatency = connectionParameters.slave_latency;
        device.connectionSupervisionTimeout = connectionParameters.conn_sup_timeout;
        device.connected = true;

        this._devices[device.instanceId] = device;
        this._attMtuMap[device.instanceId] = this.driver.GATT_MTU_SIZE_DEFAULT;

        this._changeState({ connecting: false });

        if (deviceRole === 'central') {
            this._changeState({ advertising: false });
        } else if (deviceRole === 'peripheral') {
            const callback = this._gapOperationsMap.connecting.callback;
            delete this._gapOperationsMap.connecting;

            if (_isCallback(callback)) {
                callback(undefined, device);
            }
        }

        this.emit('deviceConnected', device);
        this._addDeviceToAllPerConnectionValues(device.instanceId);
    }

    _deviceNotFound(connHandle, specificError) {
        const errorMessage = `Internal inconsistency: could not find device with connection handle: ${connHandle}.`;
        this._emitError(errorMessage, `${specificError}`);
    }

    _parseDisconnectedEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        if (!device) {
            this._deviceNotFound(event.conn_handle, 'Disconnect failed.');
            return;
        }

        device.connected = false;
        if (this._attMtuMap[device.instanceId]) {
            delete this._attMtuMap[device.instanceId];
        }

        // TODO: Delete all operations for this device.
        // TODO: How do we know what the callback expects? Check disconnected event reason?
        if (this._gapOperationsMap[device.instanceId]) {
            const callback = this._gapOperationsMap[device.instanceId].callback;
            delete this._gapOperationsMap[device.instanceId];

            if (_isCallback(callback)) {
                callback(undefined, device);
            }
        }

        if (this._gattOperationsMap[device.instanceId]) {
            const callback = this._gattOperationsMap[device.instanceId].callback;
            delete this._gattOperationsMap[device.instanceId];

            if (_isCallback(callback)) {
                callback(_makeError('Device disconnected.', `Device with address: ${device.address} disconnected.`));
            }
        }

        delete this._devices[device.instanceId];
        this.emit('deviceDisconnected', device, event.reason_name, event.reason);

        this._clearDeviceFromAllPerConnectionValues(device.instanceId);
        this._clearDeviceFromDiscoveredServices(device.instanceId);
    }

    _parseConnectionParameterUpdateEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        if (!device) {
            this._deviceNotFound(event.conn_handle, 'Connection parameter update failed.');
            return;
        }

        const connectionParameters = {
            minConnectionInterval: event.conn_params.min_conn_interval,
            maxConnectionInterval: event.conn_params.max_conn_interval,
            slaveLatency: event.conn_params.slave_latency,
            connectionSupervisionTimeout: event.conn_params.conn_sup_timeout,
        };

        Object.keys(connectionParameters).forEach(connParam => {
            device[connParam] = connectionParameters[connParam];
        });

        if (this._gapOperationsMap[device.instanceId]) {
            const callback = this._gapOperationsMap[device.instanceId].callback;
            delete this._gapOperationsMap[device.instanceId];

            if (_isCallback(callback)) {
                callback(undefined, device);
            }
        }

        this.emit('connParamUpdate', device, connectionParameters);
    }

    // TODO: should we check `device` is found for all events?

    _parseSecParamsRequestEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        this.emit('secParamsRequest', device, event.peer_params);
    }

    _parseConnSecUpdateEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        this.emit('connSecUpdate', device, event.conn_sec);

        const authParamters = {
            securityMode: event.conn_sec.sec_mode.sm,
            securityLevel: event.conn_sec.sec_mode.lv,
        };
        this.emit('securityChanged', device, authParamters);
    }

    _parseAuthStatusEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        device.ownPeriphInitiatedPairingPending = false;

        this.emit('authStatus', device, {
            auth_status: event.auth_status,
            auth_status_name: event.auth_status_name,
            error_src: event.error_src,
            error_src_name: event.error_src_name,
            bonded: event.bonded,
            sm1_levels: event.sm1_levels,
            sm2_levels: event.sm2_levels,
            kdist_own: event.kdist_own,
            kdist_peer: event.kdist_peer,
            keyset: event.keyset,
        });
    }

    _parsePasskeyDisplayEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        this.emit('passkeyDisplay', device, event.match_request, event.passkey);
    }

    _parseAuthKeyRequest(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        this.emit('authKeyRequest', device, event.key_type);
    }

    _parseGapKeyPressedEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        this.emit('keyPressed', device, event.kp_not);
    }

    _parseLescDhkeyRequest(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        this.emit('lescDhkeyRequest', device, event.pk_peer, event.oobd_req);
    }

    _parseSecInfoRequest(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        this.emit('secInfoRequest', device, event);
    }

    _parseGapSecurityRequestEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        this.emit('securityRequest', device, event);
    }

    _parseGapConnectionParameterUpdateRequestEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);

        const connectionParameters = {
            minConnectionInterval: event.conn_params.min_conn_interval,
            maxConnectionInterval: event.conn_params.max_conn_interval,
            slaveLatency: event.conn_params.slave_latency,
            connectionSupervisionTimeout: event.conn_params.conn_sup_timeout,
        };

        this.emit('connParamUpdateRequest', device, connectionParameters);
    }

    _parseGapAdvertismentReportEvent(event) {
        const address = event.peer_addr;
        const discoveredDevice = new Device(address, 'peripheral');

        discoveredDevice.processEventData(event);
        this.emit('deviceDiscovered', discoveredDevice);
    }

    _parseGapTimeoutEvent(event) {
        switch (event.src) {
            case this._bleDriver.BLE_GAP_TIMEOUT_SRC_ADVERTISING:
                this._changeState({ advertising: false });
                this.emit('advertiseTimedOut');
                break;
            case this._bleDriver.BLE_GAP_TIMEOUT_SRC_SCAN:
                this._changeState({ scanning: false });
                this.emit('scanTimedOut');
                break;
            case this._bleDriver.BLE_GAP_TIMEOUT_SRC_CONN: {
                const deviceAddress = this._gapOperationsMap.connecting.deviceAddress;
                const callback = this._gapOperationsMap.connecting.callback;
                const errorObject = _makeError('Could not connect. Connection procedure timed out.');
                if (_isCallback(callback)) {
                    callback(errorObject);
                }
                delete this._gapOperationsMap.connecting;
                this._changeState({ connecting: false });
                this.emit('connectTimedOut', deviceAddress);
                break;
            }
            case this._bleDriver.BLE_GAP_TIMEOUT_SRC_SECURITY_REQUEST: {
                const device = this._getDeviceByConnectionHandle(event.conn_handle);
                this.emit('securityRequestTimedOut', device);
                this._emitError('Security request timed out.');
                break;
            }
            default:
                console.log(`GAP operation timed out: ${event.src_name} (${event.src}).`);
        }
    }

    _parseGapRssiChangedEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        device.rssi = event.rssi;

        // TODO: How do we notify the application of a changed rssi?
        // emit('rssiChanged', device);
    }

    _parseGattcPrimaryServiceDiscoveryResponseEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        const services = event.services;
        const gattOperation = this._gattOperationsMap[device.instanceId];

        const finishServiceDiscovery = () => {
            if (_.isEmpty(gattOperation.pendingHandleReads)) {
                // No pending reads to wait for.
                const callbackServices = [];

                for (const serviceInstanceId in this._services) {
                    if (Object.prototype.hasOwnProperty.call(this._services, serviceInstanceId) ||
                        {}.hasOwnProperty.call(this._services, serviceInstanceId)) {
                        const service = this._services[serviceInstanceId];
                        if (service.deviceInstanceId === gattOperation.parent.instanceId) {
                            callbackServices.push(this._services[serviceInstanceId]);
                        }
                    }
                }

                delete this._gattOperationsMap[device.instanceId];
                gattOperation.callback(undefined, callbackServices);
            } else {
                for (const handle in gattOperation.pendingHandleReads) {
                    if (Object.prototype.hasOwnProperty.call(gattOperation.pendingHandleReads, handle) ||
                        {}.hasOwnProperty.call(gattOperation.pendingHandleReads, handle)) {
                        // Just take the first found handle and start the read process.
                        const handleAsNumber = parseInt(handle, 10);

                        this._adapter.gattcRead(device.connectionHandle, handleAsNumber, 0, err => {
                            if (err) {
                                this.emit('error', err);
                                gattOperation.callback(_makeError('Error reading attributes', err));
                            }
                        });

                        break;
                    }
                }
            }
        };

        if (event.count === 0) {
            finishServiceDiscovery();
            return;
        }

        services.forEach(service => {
            const handle = service.handle_range.start_handle;
            let uuid = HexConv.numberTo16BitUuid(service.uuid.uuid);

            if (service.uuid.type >= this._bleDriver.BLE_UUID_TYPE_VENDOR_BEGIN) {
                uuid = this._converter.lookupVsUuid(service.uuid);
            } else if (service.uuid.type === this._bleDriver.BLE_UUID_TYPE_UNKNOWN) {
                uuid = null;
            }

            const newService = new Service(device.instanceId, uuid);
            newService.startHandle = service.handle_range.start_handle;
            newService.endHandle = service.handle_range.end_handle;
            this._services[newService.instanceId] = newService;

            if (uuid === null) {
                gattOperation.pendingHandleReads[handle] = newService;
            } else {
                this.emit('serviceAdded', newService);
            }
        });

        const nextStartHandle = services[services.length - 1].handle_range.end_handle + 1;

        if (nextStartHandle > 0xFFFF) {
            finishServiceDiscovery();
            return;
        }

        this._adapter.gattcDiscoverPrimaryServices(device.connectionHandle, nextStartHandle, null, err => {
            this._checkAndPropagateError(err, 'Failed to get services', gattOperation.callback);
        });
    }

    _parseGattcCharacteristicDiscoveryResponseEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        const characteristics = event.chars;
        const gattOperation = this._gattOperationsMap[device.instanceId];

        const finishCharacteristicDiscovery = () => {
            if (_.isEmpty(gattOperation.pendingHandleReads)) {
                // No pending reads to wait for.
                const callbackCharacteristics = [];

                for (const characteristicInstanceId in this._characteristics) {
                    if (Object.prototype.hasOwnProperty.call(this._characteristics, characteristicInstanceId) ||
                        {}.hasOwnProperty.call(this._characteristics, characteristicInstanceId)) {
                        const characteristic = this._characteristics[characteristicInstanceId];
                        if (characteristic.serviceInstanceId === gattOperation.parent.instanceId) {
                            callbackCharacteristics.push(characteristic);
                        }
                    }
                }

                delete this._gattOperationsMap[device.instanceId];
                gattOperation.callback(undefined, callbackCharacteristics);
            } else {
                for (const handle in gattOperation.pendingHandleReads) {
                    if (Object.prototype.hasOwnProperty.call(gattOperation.pendingHandleReads, handle) ||
                        {}.hasOwnProperty.call(gattOperation.pendingHandleReads, handle)) {
                        // Only take the first found handle and start the read process.
                        const handleAsNumber = parseInt(handle, 10);
                        this._adapter.gattcRead(device.connectionHandle, handleAsNumber, 0, err => {
                            this._checkAndPropagateError(err, `Failed to get characteristic with handle ${handleAsNumber}`, gattOperation.callback);
                        });
                        break;
                    }
                }
            }
        };

        if (event.count === 0) {
            finishCharacteristicDiscovery();
            return;
        }

        // We should only receive characteristics under one service.
        const service = this._getServiceByHandle(device.instanceId, characteristics[0].handle_decl);

        characteristics.forEach(characteristic => {
            const declarationHandle = characteristic.handle_decl;
            const valueHandle = characteristic.handle_value;
            let uuid = HexConv.numberTo16BitUuid(characteristic.uuid.uuid);

            if (characteristic.uuid.type >= this._bleDriver.BLE_UUID_TYPE_VENDOR_BEGIN) {
                uuid = this._converter.lookupVsUuid(characteristic.uuid);
            } else if (characteristic.uuid.type === this._bleDriver.BLE_UUID_TYPE_UNKNOWN) {
                uuid = null;
            }

            const properties = characteristic.char_props;

            const newCharacteristic = new Characteristic(service.instanceId, uuid, [], properties);
            newCharacteristic.declarationHandle = characteristic.handle_decl;
            newCharacteristic.valueHandle = characteristic.handle_value;
            this._characteristics[newCharacteristic.instanceId] = newCharacteristic;

            if (uuid === null) {
                gattOperation.pendingHandleReads[declarationHandle] = newCharacteristic;
            }

            // Add pending reads to get characteristics values.
            if (properties.read) {
                gattOperation.pendingHandleReads[valueHandle] = newCharacteristic;
            }
        });

        const nextStartHandle = characteristics[characteristics.length - 1].handle_decl + 1;
        const handleRange = { start_handle: nextStartHandle, end_handle: service.endHandle };

        if (service.endHandle <= nextStartHandle) {
            finishCharacteristicDiscovery();
            return;
        }

        // Do one more round with discovery of characteristics
        this._adapter.gattcDiscoverCharacteristics(device.connectionHandle, handleRange, err => {
            if (err) {
                this.emit('error', 'Failed to get Characteristics');

                // Call getCharacteristics callback??
            }
        });
    }

    _parseGattcDescriptorDiscoveryResponseEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        const descriptors = event.descs;
        const gattOperation = this._gattOperationsMap[device.instanceId];

        const finishDescriptorDiscovery = () => {
            if (_.isEmpty(gattOperation.pendingHandleReads)) {
                // No pending reads to wait for.
                const callbackDescriptors = [];

                for (const descriptorInstanceId in this._descriptors) {
                    if (Object.prototype.hasOwnProperty.call(this._descriptors, descriptorInstanceId) ||
                        {}.hasOwnProperty.call(this._descriptors, descriptorInstanceId)) {
                        const descriptor = this._descriptors[descriptorInstanceId];
                        if (descriptor.characteristicInstanceId === gattOperation.parent.instanceId) {
                            callbackDescriptors.push(descriptor);
                        }
                    }
                }

                delete this._gattOperationsMap[device.instanceId];
                gattOperation.callback(undefined, callbackDescriptors);
            } else {
                for (const handle in gattOperation.pendingHandleReads) {
                    if (Object.prototype.hasOwnProperty.call(gattOperation.pendingHandleReads, handle) ||
                        {}.hasOwnProperty.call(gattOperation.pendingHandleReads, handle)) {
                        const handleAsNumber = parseInt(handle, 10);

                        // Just take the first found handle and start the read process.
                        this._adapter.gattcRead(device.connectionHandle, handleAsNumber, 0, err => {
                            if (err) {
                                this.emit('error', err);

                                // Call getDescriptors callback??
                            }
                        });
                        break;
                    }
                }
            }
        };

        if (event.count === 0) {
            finishDescriptorDiscovery();
            return;
        }

        // We should only receive descriptors under one characteristic.
        const characteristic = gattOperation.parent;
        let foundNextServiceOrCharacteristic = false;

        descriptors.forEach(descriptor => {
            if (foundNextServiceOrCharacteristic) {
                return;
            }

            const handle = descriptor.handle;
            let uuid = HexConv.numberTo16BitUuid(descriptor.uuid.uuid);

            if (descriptor.uuid.type >= this._bleDriver.BLE_UUID_TYPE_VENDOR_BEGIN) {
                uuid = this._converter.lookupVsUuid(descriptor.uuid);
            } else if (descriptor.uuid.type === this._bleDriver.BLE_UUID_TYPE_UNKNOWN) {
                uuid = 'Unknown 128 bit descriptor uuid ';
            }

            // TODO: Fix magic number? Primary Service and Characteristic Declaration uuids
            if (uuid === '2800' || uuid === '2803') {
                // Found a service or characteristic declaration
                foundNextServiceOrCharacteristic = true;
                return;
            }

            const newDescriptor = new Descriptor(characteristic.instanceId, uuid, null);
            newDescriptor.handle = handle;
            this._descriptors[newDescriptor.instanceId] = newDescriptor;

            // TODO: We cannot read descriptor 128bit uuid.

            gattOperation.pendingHandleReads[handle] = newDescriptor;
        });

        if (foundNextServiceOrCharacteristic) {
            finishDescriptorDiscovery();
            return;
        }

        const service = this._services[gattOperation.parent.serviceInstanceId];
        const nextStartHandle = descriptors[descriptors.length - 1].handle + 1;

        if (service.endHandle < nextStartHandle) {
            finishDescriptorDiscovery();
            return;
        }

        const handleRange = { start_handle: nextStartHandle, end_handle: service.endHandle };

        this._adapter.gattcDiscoverDescriptors(device.connectionHandle, handleRange, err => {
            this._checkAndPropagateError(err, 'Failed to get Descriptors');
        });
    }

    _parseGattcReadResponseEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        const handle = event.handle;
        const data = event.data;
        const gattOperation = this._gattOperationsMap[device.instanceId];

        if (gattOperation && gattOperation.pendingHandleReads && !_.isEmpty(gattOperation.pendingHandleReads)) {
            const pendingHandleReads = gattOperation.pendingHandleReads;
            const attribute = pendingHandleReads[handle];

            const addVsUuidToDriver = uuid => {
                return new Promise((resolve, reject) => {
                    this._converter.uuidToDriver(uuid, (err, _uuid) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        resolve();
                    });
                });
            };

            if (!attribute) {
                console.log('something went wrong in bookkeeping of pending reads');
                return;
            }

            delete pendingHandleReads[handle];

            if (attribute instanceof Service) {
                // TODO: Translate from uuid to name?
                attribute.uuid = HexConv.arrayTo128BitUuid(data);
                addVsUuidToDriver(attribute.uuid).then();
                this.emit('serviceAdded', attribute);

                if (_.isEmpty(pendingHandleReads)) {
                    const callbackServices = [];
                    for (const serviceInstanceId in this._services) {
                        if (this._services[serviceInstanceId].deviceInstanceId === device.instanceId) {
                            callbackServices.push(this._services[serviceInstanceId]);
                        }
                    }

                    delete this._gattOperationsMap[device.instanceId];
                    gattOperation.callback(undefined, callbackServices);
                }
            } else if (attribute instanceof Characteristic) {
                // TODO: Translate from uuid to name?
                if (handle === attribute.declarationHandle) {
                    attribute.uuid = HexConv.arrayTo128BitUuid(data.slice(3));
                    addVsUuidToDriver(attribute.uuid).then();
                } else if (handle === attribute.valueHandle) {
                    attribute.value = data;
                }

                if (attribute.uuid && attribute.value) {
                    this.emit('characteristicAdded', attribute);
                }

                if (_.isEmpty(pendingHandleReads)) {
                    const callbackCharacteristics = [];

                    for (const characteristicInstanceId in this._characteristics) {
                        if (this._characteristics[characteristicInstanceId].serviceInstanceId === attribute.serviceInstanceId) {
                            callbackCharacteristics.push(this._characteristics[characteristicInstanceId]);
                        }
                    }

                    delete this._gattOperationsMap[device.instanceId];
                    gattOperation.callback(undefined, callbackCharacteristics);
                }
            } else if (attribute instanceof Descriptor) {
                attribute.value = data;

                if (attribute.uuid && attribute.value) {
                    this.emit('descriptorAdded', attribute);
                }

                if (_.isEmpty(pendingHandleReads)) {
                    const callbackDescriptors = [];
                    for (const descriptorInstanceId in this._descriptors) {
                        if (this._descriptors[descriptorInstanceId].characteristicInstanceId === attribute.characteristicInstanceId) {
                            callbackDescriptors.push(this._descriptors[descriptorInstanceId]);
                        }
                    }

                    delete this._gattOperationsMap[device.instanceId];
                    gattOperation.callback(undefined, callbackDescriptors);
                }
            }

            for (const newReadHandle in pendingHandleReads) {
                if (Object.prototype.hasOwnProperty.call(pendingHandleReads, newReadHandle) ||
                    {}.hasOwnProperty.call(pendingHandleReads, newReadHandle)) {
                    const newReadHandleAsNumber = parseInt(newReadHandle, 10);

                    // Just take the first found handle and start the read process.
                    this._adapter.gattcRead(device.connectionHandle, newReadHandleAsNumber, 0, err => {
                        if (err) {
                            this.emit('error', err);

                            // Call getAttributecallback callback??
                        }
                    });
                    break;
                }
            }
        } else {
            if (event.gatt_status !== this._bleDriver.BLE_GATT_STATUS_SUCCESS) {
                delete this._gattOperationsMap[device.instanceId];
                gattOperation.callback(_makeError(`Read operation failed: ${event.gatt_status_name} (0x${HexConv.numberToHexString(event.gatt_status)})`));
                return;
            }

            gattOperation.readBytes = gattOperation.readBytes ? gattOperation.readBytes.concat(event.data) : event.data;

            if (event.data.length < this._maxReadPayloadSize(device.instanceId)) {
                delete this._gattOperationsMap[device.instanceId];
                gattOperation.callback(undefined, gattOperation.readBytes);
            } else if (event.data.length === this._maxReadPayloadSize(device.instanceId)) {
                // We need to read more:
                this._adapter.gattcRead(event.conn_handle, event.handle, gattOperation.readBytes.length, err => {
                    if (err) {
                        delete this._gattOperationsMap[device.instanceId];
                        this.emit('error', _makeError('Read value failed', err));
                        gattOperation.callback(`Failed reading at byte #: ${gattOperation.readBytes.length}.`);
                    }
                });
            } else {
                delete this._gattOperationsMap[device.instanceId];
                this.emit('error', 'Length of Read response is > mtu');
                gattOperation.callback('Invalid read response length. (> mtu)');
            }
        }
    }

    _parseGattcWriteResponseEvent(event) {
        // 1. Check if there is a long write in progress for this device
        // 2a. If there is check if it is done after next write
        // 2ai. If it is done after next write
        //      Perform the last write and if success, exec write on fail, cancel write
        //      callback, delete callback, delete pending write, emit
        // 2aii. if not done, issue one more PREPARED_WRITE, update pendingwrite

        // TODO: Do more checking of write response?
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        const handle = event.handle;
        const gattOperation = this._gattOperationsMap[device.instanceId];

        if (!device) {
            delete this._gattOperationsMap[device.instanceId];
            const errorStr = `Failed to handle write event, device with connection handle: ${event.conn_handle} not found.`;
            this.emit('error', errorStr);
            gattOperation.callback(_makeError(errorStr));
            return;
        }

        if (event.write_op === this._bleDriver.BLE_GATT_OP_WRITE_CMD) {
            gattOperation.attribute.value = gattOperation.value;
        } else if (event.write_op === this._bleDriver.BLE_GATT_OP_PREP_WRITE_REQ) {
            const writeParameters = {
                write_op: 0,
                flags: 0,
                handle,
                offset: 0,
                len: 0,
                value: [],
            };

            if (gattOperation.bytesWritten < gattOperation.value.length) {
                const value = gattOperation.value.slice(gattOperation.bytesWritten, gattOperation.bytesWritten + this._maxLongWritePayloadSize(device.instanceId));

                writeParameters.write_op = this._bleDriver.BLE_GATT_OP_PREP_WRITE_REQ;
                writeParameters.handle = handle;
                writeParameters.offset = gattOperation.bytesWritten;
                writeParameters.len = value.length;
                writeParameters.value = value;
                gattOperation.bytesWritten += value.length;

                this._adapter.gattcWrite(device.connectionHandle, writeParameters, err => {
                    if (err) {
                        console.log('some error');
                        this._longWriteCancel(device, gattOperation.attribute);
                        this.emit('error', _makeError(`Failed to long write value of device/handle:
                                                       ${device.instanceId}/${handle}.`, err));
                        return;
                    }
                });
            } else {
                writeParameters.write_op = this._bleDriver.BLE_GATT_OP_EXEC_WRITE_REQ;
                writeParameters.flags = this._bleDriver.BLE_GATT_EXEC_WRITE_FLAG_PREPARED_WRITE;

                this._adapter.gattcWrite(device.connectionHandle, writeParameters, err => {
                    if (err) {
                        this._longWriteCancel(device, gattOperation.attribute);
                        this.emit('error', _makeError(`Failed to long write value of device/handle: 
                                                       ${device.instanceId}/'${handle}.`, err));
                    }
                });
            }

            return;
        } else if (event.write_op === this._bleDriver.BLE_GATT_OP_WRITE_REQ ||
                   event.write_op === this._bleDriver.BLE_GATT_OP_EXEC_WRITE_REQ) {
            gattOperation.attribute.value = gattOperation.value;
            delete this._gattOperationsMap[device.instanceId];
            if (event.gatt_status !== this._bleDriver.BLE_GATT_STATUS_SUCCESS) {
                gattOperation.callback(_makeError(`Write operation failed: ${event.gatt_status_name} (0x${HexConv.numberToHexString(event.gatt_status)})`));
                return;
            }
        }

        this._emitAttributeValueChanged(gattOperation.attribute);

        gattOperation.callback(undefined, gattOperation.attribute);
    }

    _getServiceByHandle(deviceInstanceId, handle) {
        let foundService = null;

        Object.keys(this._services).forEach(serviceInstanceId => {
            const service = this._services[serviceInstanceId];
            if (_.isEqual(service.deviceInstanceId, deviceInstanceId)) {
                if (service.startHandle <= handle &&
                    (!foundService || foundService.startHandle <= service.startHandle)) {
                    foundService = service;
                }
            }
        });

        return foundService;
    }

    _getCharacteristicByHandle(deviceInstanceId, handle) {
        const service = this._getServiceByHandle(deviceInstanceId, handle);
        let foundCharacteristic = null;

        Object.keys(this._characteristics).forEach(characteristicInstanceId => {
            const characteristic = this._characteristics[characteristicInstanceId];
            if (_.isEqual(characteristic.serviceInstanceId, service.instanceId)) {
                if (characteristic.declarationHandle <= handle &&
                    (!foundCharacteristic || foundCharacteristic.declarationHandle < characteristic.declarationHandle)) {
                    foundCharacteristic = characteristic;
                }
            }
        });

        return foundCharacteristic;
    }

    _getCharacteristicByValueHandle(devinceInstanceId, valueHandle) {
        return _.find(this._characteristics, characteristic => this._services[characteristic.serviceInstanceId].deviceInstanceId === devinceInstanceId && characteristic.valueHandle === valueHandle);
    }

    _getDescriptorByHandle(deviceInstanceId, handle) {
        const characteristic = this._getCharacteristicByHandle(deviceInstanceId, handle);

        Object.keys(this._descriptors).forEach(descriptorInstanceId => {
            const descriptor = this._descriptors[descriptorInstanceId];
            if (_.isEqual(descriptor.characteristicInstanceId, characteristic.instanceId)) {
                if (descriptor.handle === handle) {
                    return descriptor;
                }
            }
        });

        return null;
    }

    _getAttributeByHandle(deviceInstanceId, handle) {
        return this._getDescriptorByHandle(deviceInstanceId, handle) ||
            this._getCharacteristicByValueHandle(deviceInstanceId, handle) ||
            this._getCharacteristicByHandle(deviceInstanceId, handle) ||
            this._getServiceByHandle(deviceInstanceId, handle);
    }

    _emitAttributeValueChanged(attribute) {
        if (attribute instanceof Characteristic) {
            this.emit('characteristicValueChanged', attribute);
        } else if (attribute instanceof Descriptor) {
            this.emit('descriptorValueChanged', attribute);
        }
    }

    _parseGattcHvxEvent(event) {
        if (event.type === this._bleDriver.BLE_GATT_HVX_INDICATION) {
            this._adapter.gattcConfirmHandleValue(event.conn_handle, event.handle, error => {
                if (error) {
                    this.emit('error', _makeError('Failed to call gattcConfirmHandleValue', error));
                }
            });
        }

        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        const characteristic = this._getCharacteristicByValueHandle(device.instanceId, event.handle);
        if (!characteristic) {
            this.emit('logMessage', logLevel.DEBUG, `Cannot handle HVX event. No characteristic value with handle ${event.handle} found.`);
            return;
        }

        characteristic.value = event.data;
        this.emit('characteristicValueChanged', characteristic);
    }

    _parseGattcExchangeMtuResponseEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        const gattOperation = this._gattOperationsMap[device.instanceId];

        const previousMtu = this._attMtuMap[device.instanceId];
        const newMtu = Math.min(event.server_rx_mtu, gattOperation.clientRxMtu);

        this._attMtuMap[device.instanceId] = newMtu;

        if (newMtu !== previousMtu) {
            this.emit('attMtuChanged', device, newMtu);
        }

        if (gattOperation && gattOperation.callback) {
            gattOperation.callback(null, newMtu);
            delete this._gattOperationsMap[device.instanceId];
        }
    }

    _parseGattTimeoutEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        const gattOperation = this._gattOperationsMap[device.instanceId];
        const error = _makeError('Received a Gatt timeout');
        this.emit('error', error);

        if (gattOperation) {
            if (gattOperation.callback) {
                gattOperation.callback(error);
            }

            delete this._gattOperationsMap[device.instanceId];
        }
    }

    _parseGattsWriteEvent(event) {
        // TODO: BLE_GATTS_OP_SIGN_WRITE_CMD not supported?
        // TODO: Support auth_required flag
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        const attribute = this._getAttributeByHandle('local.server', event.handle);

        if (event.op === this._bleDriver.BLE_GATTS_OP_WRITE_REQ ||
            event.op === this._bleDriver.BLE_GATTS_OP_WRITE_CMD) {
            if (this._instanceIdIsOnLocalDevice(attribute.instanceId) && this._isCCCDDescriptor(attribute.instanceId)) {
                this._setDescriptorValue(attribute, event.data, device.instanceId);
                this._emitAttributeValueChanged(attribute);
            } else {
                this._setAttributeValueWithOffset(attribute, event.data, event.offset);
                this._emitAttributeValueChanged(attribute);
            }
        }
    }

    _parseGattsRWAutorizeRequestEvent(event) {
        const device = this._getDeviceByConnectionHandle(event.conn_handle);
        let promiseChain = new Promise(resolve => resolve());
        let authorizeReplyParams;

        const createWritePromise = (handle, data, offset) => {
            return new Promise((resolve, reject) => {
                const attribute = this._getAttributeByHandle('local.server', handle);
                this._writeLocalValue(attribute, data, offset, error => {
                    if (error) {
                        this.emit('error', _makeError('Failed to set local attribute value from rwAuthorizeRequest', error));
                        reject(_makeError('Failed to set local attribute value from rwAuthorizeRequest', error));
                    } else {
                        this._emitAttributeValueChanged(attribute);
                        resolve();
                    }
                });
            });
        };

        if (event.type === this._bleDriver.BLE_GATTS_AUTHORIZE_TYPE_WRITE) {
            if (event.write.op === this._bleDriver.BLE_GATTS_OP_WRITE_REQ) {
                promiseChain = promiseChain.then(() => {
                    createWritePromise(event.write.handle, event.write.data, event.write.offset);
                });

                authorizeReplyParams = {
                    type: event.type,
                    write: {
                        gatt_status: this._bleDriver.BLE_GATT_STATUS_SUCCESS,
                        update: 1,
                        offset: event.write.offset,
                        len: event.write.len,
                        data: event.write.data,
                    },
                };
            } else if (event.write.op === this._bleDriver.BLE_GATTS_OP_PREP_WRITE_REQ) {
                if (!this._preparedWritesMap[device.instanceId]) {
                    this._preparedWritesMap[device.instanceId] = [];
                }

                let preparedWrites = this._preparedWritesMap[device.instanceId];
                preparedWrites = preparedWrites.concat({ handle: event.write.handle, value: event.write.data, offset: event.write.offset });

                this._preparedWritesMap[device.instanceId] = preparedWrites;

                authorizeReplyParams = {
                    type: event.type,
                    write: {
                        gatt_status: this._bleDriver.BLE_GATT_STATUS_SUCCESS,
                        update: 1,
                        offset: event.write.offset,
                        len: event.write.len,
                        data: event.write.data,
                    },
                };

            } else if (event.write.op === this._bleDriver.BLE_GATTS_OP_EXEC_WRITE_REQ_CANCEL) {
                delete this._preparedWritesMap[device.instanceId];

                authorizeReplyParams = {
                    type: event.type,
                    write: {
                        gatt_status: this._bleDriver.BLE_GATT_STATUS_SUCCESS,
                        update: 0,
                        offset: 0,
                        len: 0,
                        data: [],
                    },
                };
            } else if (event.write.op === this._bleDriver.BLE_GATTS_OP_EXEC_WRITE_REQ_NOW) {
                for (const preparedWrite of this._preparedWritesMap[device.instanceId]) {
                    promiseChain = promiseChain.then(() => {
                        createWritePromise(preparedWrite.handle, preparedWrite.value, preparedWrite.offset);
                    });
                }

                delete this._preparedWritesMap[device.instanceId];

                authorizeReplyParams = {
                    type: event.type,
                    write: {
                        gatt_status: this._bleDriver.BLE_GATT_STATUS_SUCCESS,
                        update: 0,
                        offset: 0,
                        len: 0,
                        data: [],
                    },
                };
            }
        } else if (event.type === this._bleDriver.BLE_GATTS_AUTHORIZE_TYPE_READ) {
            authorizeReplyParams = {
                type: event.type,
                read: {
                    gatt_status: this._bleDriver.BLE_GATT_STATUS_SUCCESS,
                    update: 0, // 0 = Don't provide data here, read from server.
                    offset: 0,
                    len: 0,
                    data: [],
                },
            };
        }

        promiseChain.then(() => {
            this._adapter.gattsReplyReadWriteAuthorize(event.conn_handle, authorizeReplyParams, error => {
                if (error) {
                    this.emit('error', _makeError('Failed to call gattsReplyReadWriteAuthorize', error));
                }
            });
        });
    }

    _parseGattsSysAttrMissingEvent(event) {
        this._adapter.gattsSystemAttributeSet(event.conn_handle, null, 0, 0, error => {
            if (error) {
                this.emit('error', _makeError('Failed to call gattsSystemAttributeSet', error));
            }
        });
    }

    _parseGattsHvcEvent(event) {
        const remoteDevice = this._getDeviceByConnectionHandle(event.conn_handle);
        const characteristic = this._getCharacteristicByHandle('local.server', event.handle);

        if (this._pendingNotificationsAndIndications.deviceNotifiedOrIndicated) {
            this._pendingNotificationsAndIndications.deviceNotifiedOrIndicated(remoteDevice, characteristic);
        }

        this.emit('deviceNotifiedOrIndicated', remoteDevice, characteristic);

        this._pendingNotificationsAndIndications.remainingIndicationConfirmations -= 1;
        if (this._sendingNotificationsAndIndicationsComplete()) {
            this._pendingNotificationsAndIndications.completeCallback(undefined, characteristic);
            this._pendingNotificationsAndIndications = {};
        }
    }

    _parseGattsExchangeMtuRequestEvent(event) {
        const remoteDevice = this._getDeviceByConnectionHandle(event.conn_handle);

        this._adapter.gattsExchangeMtuReply(event.conn_handle, event.client_rx_mtu, error => {
            if (error) {
                this.emit('error', _makeError('Failed to call gattsExchangeMtuReply', error));
                return;
            }

            const previousMtu = this._attMtuMap[remoteDevice.instanceId];
            const newMtu = event.client_rx_mtu;
            this._attMtuMap[remoteDevice.instanceId] = newMtu;

            if (newMtu !== previousMtu) {
                this.emit('attMtuChanged', remoteDevice, event.client_rx_mtu);
            }
        });
    }

    _parseMemoryRequestEvent(event) {
        if (event.type === this._bleDriver.BLE_USER_MEM_TYPE_GATTS_QUEUED_WRITES) {
            this._adapter.replyUserMemory(event.conn_handle, null, error => {
                if (error) {
                    this.emit('error', _makeError('Failed to call replyUserMemory', error));
                }
            });
        }
    }

    _parseTxCompleteEvent(event) {
        const remoteDevice = this._getDeviceByConnectionHandle(event.conn_handle);
        this.emit('txComplete', remoteDevice, event.count);
    }

    _parseDataLengthChangedEvent(event) {
        const remoteDevice = this._getDeviceByConnectionHandle(event.conn_handle);
        this.emit('dataLengthChanged', remoteDevice, event.max_tx_octets);
    }

    _setAttributeValueWithOffset(attribute, value, offset) {
        attribute.value = attribute.value.slice(0, offset).concat(value);
    }

    /**
     * Gets and updates this adapter's state.
     *
     * @param {function} callback Callback signature: (err, state) => {}.
     * @returns {void}
     */
    getState(callback) {
        const changedStates = {};
        this._adapter.getVersion((version, err) => {
            if (this._checkAndPropagateError(err, 'Failed to retrieve the SoftDevice\'s firmware version.', callback)) {
                return;
            }

            changedStates.firmwareVersion = version;
            this._adapter.gapGetDeviceName((name, err) => {
                if (this._checkAndPropagateError(err, 'Failed to retrieve the BLE device\'s name.', callback)) {
                    return;
                }

                changedStates.name = name;
                this._adapter.gapGetAddress((address, err) => {
                    if (this._checkAndPropagateError(err, 'Failed to retrieve the BLE device\'s address.', callback)) {
                        return;
                    }

                    changedStates.address = address;
                    changedStates.available = true;
                    this._changeState(changedStates);

                    if (_isCallback(callback)) {
                        callback(undefined, this._state);
                    }
                });
            });
        });
    }

    /**
     * Sets this adapter's BLE device's GAP name.
     *
     * @param {string} name GAP device name.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    setName(name, callback) {
        const _name = name.split();
        this._adapter.gapSetDeviceName({ sm: 0, lv: 0 }, _name, err => {
            if (err) {
                this.emit('error', _makeError('Failed to set the BLE device\'s GAP name.', err));
            } else if (this._state.name !== name) {
                this._state.name = name;
                this._changeState({ name });
            }

            if (_isCallback(callback)) {
                callback(err);
            }
        });
    }

    /**
     * @summary Sets this adapter's BLE device's local Bluetooth identity address.
     *
     * The local Bluetooth identity address is the address that identifies this device to other peers.
     * The address type must be either `BLE_GAP_ADDR_TYPE_PUBLIC` or 'BLE_GAP_ADDR_TYPE_RANDOM_STATIC'.
     * The identity address cannot be changed while roles are running.
     *
     * @param {string} address The local Bluetooth identity address.
     * @param {string} type The address type. 'BLE_GAP_ADDR_TYPE_RANDOM_STATIC' or `BLE_GAP_ADDR_TYPE_PUBLIC`.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    setAddress(address, type, callback) {
        // TODO: if privacy is active use this._bleDriver.BLE_GAP_ADDR_CYCLE_MODE_AUTO?
        const cycleMode = this._bleDriver.BLE_GAP_ADDR_CYCLE_MODE_NONE;
        const addressStruct = { address, type };

        this._adapter.gapSetAddress(cycleMode, addressStruct, err => {
            if (err) {
                this.emit('error', _makeError('Failed to set the BLE device\'s GAP address.', err));
            } else if (this._state.address !== address) {
                this._changeState({ address });
            }

            if (_isCallback()) {
                callback(err);
            }
        });
    }

    _setDeviceName(deviceName, security, callback) {
        const convertedSecurity = Converter.securityModeToDriver(security);

        this._adapter.gapSetDeviceName(convertedSecurity, deviceName, err => {
            if (err) {
                this.emit('error', _makeError('Failed to set BLE device\'s device GAP name.', err));
            }

            if (_isCallback()) {
                callback(err);
            }
        });
    }

    _setDeviceNameFromArray(valueArray, writePerm, callback) {
        const nameArray = valueArray.concat(0);
        this._setDeviceName(nameArray, writePerm, callback);
    }

    _setAppearance(appearance, callback) {
        this._adapter.gapSetAppearance(appearance, err => {
            if (err) {
                this.emit('error', _makeError('Failed to set appearance', err));
            }

            if (_isCallback()) {
                callback(err);
            }
        });
    }

    _setAppearanceFromArray(valueArray, callback) {
        const appearanceValue = valueArray[0] + (valueArray[1] << 8);
        this._setAppearance(appearanceValue, callback);
    }

    _setPPCP(ppcp, callback) {
        this._adapter.gapSetPPCP(ppcp, err => {
            if (err) {
                this.emit('error', _makeError('Failed to set PPCP', err));
            }

            if (_isCallback()) {
                callback(err);
            }
        });
    }

    _setPPCPFromArray(valueArray, callback) {
        // TODO: Fix addon parameter check to also accept arrays? Atleast avoid converting twice
        const ppcpParameter = {
            min_conn_interval: (valueArray[0] + (valueArray[1] << 8)) * (1250 / 1000),
            max_conn_interval: (valueArray[2] + (valueArray[3] << 8)) * (1250 / 1000),
            slave_latency: (valueArray[4] + (valueArray[5] << 8)),
            conn_sup_timeout: (valueArray[6] + (valueArray[7] << 8)) * (10000 / 1000),
        };

        this._setPPCP(ppcpParameter, callback);
    }

    /**
     * Get this adapter's connected device/devices.
     * @returns {[Device]} An array of this adapter's connected device/devices.
     */
    getDevices() {
        return this._devices;
    }

    /**
     * Get a device connected to this adapter by its instanceId.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @returns {null|Device} The device connected to this adapter corresponding to `deviceInstanceId`.
     */
    getDevice(deviceInstanceId) {
        return this._devices[deviceInstanceId];
    }

    _getDeviceByConnectionHandle(connectionHandle) {
        const foundDeviceId = Object.keys(this._devices).find(deviceId => {
            return this._devices[deviceId].connectionHandle === connectionHandle;
        });
        return this._devices[foundDeviceId];
    }

    _getDeviceByAddress(address) {
        const foundDeviceId = Object.keys(this._devices).find(deviceId => {
            return this._devices[deviceId].address === address;
        });
        return this._devices[foundDeviceId];
    }


    /**
     * @summary Start scanning (GAP Discovery procedure, Observer Procedure).
     *
     * Available scan parameters:
     * - {boolean} active If 1, perform active scanning (scan requests).
     * - {number} interval Scan interval between 0x0004 and 0x4000 in 0.625ms units (2.5ms to 10.24s).
     * - {number} window Scan window between 0x0004 and 0x4000 in 0.625ms units (2.5ms to 10.24s).
     * - {number} timeout Scan timeout between 0x0001 and 0xFFFF in seconds, 0x0000 disables timeout.
     * - {number} use_whitelist If 1, filter advertisers using current active whitelist.
     * - {number} adv_dir_report If 1, also report directed advertisements where the initiator field is set to a
     *                           private resolvable address, even if the address did not resolve to an entry in the
     *                           device identity list. A report will be generated even if the peer is not in the whitelist.
     * @param {Object} options The GAP scanning parameters.
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    startScan(options, callback) {
        this._adapter.gapStartScan(options, err => {
            if (err) {
                this.emit('error', _makeError('Error occurred when starting scan.', err));
            } else {
                this._changeState({ scanning: true });
            }

            if (_isCallback()) {
                callback(err);
            }
        });
    }

    /**
     * Stop scanning (GAP Discovery procedure, Observer Procedure).
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    stopScan(callback) {
        this._adapter.gapStopScan(err => {
            if (err) {
                // TODO: probably is state already set to false, but should we make sure? if yes, emit stateChanged?
                this.emit('error', _makeError('Error occurred when stopping scanning.', err));
            } else {
                this._changeState({ scanning: false });
            }

            if (_isCallback()) {
                callback(err);
            }
        });
    }

    /**
     * @summary Create a connection (GAP Link Establishment).
     *
     * If a scanning procedure is currently in progress it will be automatically stopped when calling this function.
     *
     * @param {string} deviceAddress The peer address. If the use_whitelist bit is set in scanParams, then this is ignored.
     *
     * Available options:
     * - {Object} scanParams:
     *                - {boolean} active: If 1, perform active scanning (scan requests).
     *                - {number} interval: Scan interval between 0x0004 and 0x4000 in 0.625ms units (2.5ms to 10.24s).
     *                - {number} window: Scan window between 0x0004 and 0x4000 in 0.625ms units (2.5ms to 10.24s).
     *                - {number} timeout: Scan timeout between 0x0001 and 0xFFFF in seconds, 0x0000 disables timeout.
     *                - {number} use_whitelist: If 1, filter advertisers using current active whitelist.
     *                - {number} adv_dir_report: If 1, also report directed advertisements where the initiator field is set to a
     *                                          private resolvable address, even if the address did not resolve to an entry in the
     *                                          device identity list. A report will be generated even if the peer is not in the whitelist.
     * - {Object} connParams:
     *                - {number} min_conn_interval: Minimum Connection Interval in 1.25 ms units.
     *                - {number} max_conn_interval:  Maximum Connection Interval in 1.25 ms units.
     *                - {number} slave_latency: Slave Latency in number of connection events.
     *                - {number} conn_sup_timeout: Connection Supervision Timeout in 10 ms units.
     * @param {Object} options The scan and connection parameters.
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    connect(deviceAddress, options, callback) {
        if (!_.isEmpty(this._gapOperationsMap)) {
            this._checkAndPropagateError('Could not connect.', 'Another connection request is in progress.', callback);
            return;
        }

        let address = {};

        if (typeof deviceAddress === 'string') {
            address.address = deviceAddress;
            address.type = 'BLE_GAP_ADDR_TYPE_RANDOM_STATIC';
        } else {
            address = deviceAddress;
        }

        this._changeState({ scanning: false, connecting: true });

        this._adapter.gapConnect(address, options.scanParams, options.connParams, err => {
            if (err) {
                this._changeState({ connecting: false });
                const error = (err.errcode === 'NRF_ERROR_CONN_COUNT') ?
                    _makeError('Could not connect. Max number of connections reached.', err) :
                    _makeError(`Could not connect to ${deviceAddress.address}.`, err);

                this.emit('error', error);
                if (_isCallback(callback)) {
                    callback(error);
                }
            } else {
                this._gapOperationsMap.connecting = { deviceAddress: address, callback };
                
                if (_isCallback(callback)) {
                    callback();
                }
            }
        });
    }

    /**
     * Cancel a connection establishment.
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    cancelConnect(callback) {
        this._adapter.gapCancelConnect(err => {
            if (err) {
                this._checkAndPropagateError(err, 'Error occurred when cancelling connection request.', callback);
                return;
            }

            delete this._gapOperationsMap.connecting;
            this._changeState({ connecting: false });

            if (_isCallback(callback)) {
                callback();
            }
        });
    }

    // enable the client role and starts advertising
    _getAdvertisementParams(params) {
        const retval = {};

        retval.channel_mask = {};
        retval.channel_mask.ch_37_off = false;
        retval.channel_mask.ch_38_off = false;
        retval.channel_mask.ch_39_off = false;

        if (params.channelMask) {
            for (const channel in params.channelMask) {
                if (Object.prototype.hasOwnProperty.call(params.channelMask, channel) ||
                    {}.hasOwnProperty.call(params.channelMask, channel)) {
                    switch (params.channelMask[channel]) {
                        case 'ch37off':
                            retval.channel_mask.ch_37_off = true;
                            break;
                        case 'ch38off':
                            retval.channel_mask.ch_38_off = true;
                            break;
                        case 'ch39off':
                            retval.channel_mask.ch_39_off = true;
                            break;
                        default:
                            throw new Error(`Channel ${channel} is not possible to switch off during advertising.`);
                    }
                }
            }
        }

        if (params.interval) {
            retval.interval = params.interval;
        } else {
            throw new Error('You have to provide an interval.');
        }

        if (params.timeout || params.timeout === 0) {
            retval.timeout = params.timeout;
        } else {
            throw new Error('You have to provide a timeout.');
        }

        // TOOD: fix fp logic later
        retval.fp = this._bleDriver.BLE_GAP_ADV_FP_ANY;

        // Default value is that device is connectable undirected.
        retval.type = this._bleDriver.BLE_GAP_ADV_TYPE_ADV_IND;

        // TODO: we do not support directed connectable mode yet
        if (params.connectable !== undefined) {
            if (!params.connectable) {
                retval.type |= this._bleDriver.BLE_GAP_ADV_TYPE_NONCONN_IND;
            }
        }

        if (params.scannable !== undefined) {
            if (params.scannable) {
                retval.type |= this._bleDriver.BLE_GAP_ADV_TYPE_ADV_SCAN_IND;
            }
        }

        return retval;
    }

    /**
     * @summary Start advertising (GAP Discoverable, Connectable modes, Broadcast Procedure).
     *
     * An application can start an advertising procedure for broadcasting purposes while a connection
     * is active. After a BLE_GAP_EVT_CONNECTED event is received, this function may therefore
     * be called to start a broadcast advertising procedure. The advertising procedure
     * cannot however be connectable (it must be of type BLE_GAP_ADV_TYPE_ADV_SCAN_IND or
     *  BLE_GAP_ADV_TYPE_ADV_NONCONN_IND).
     *
     * Only one advertiser may be active at any time.
     *
     * Available GAP advertising parameters:
     * - {number} channelMask: Channel mask for RF channels used in advertising. Default: all channels on.
     * - {number} interval: GAP Advertising interval. Required: an interval must be provided.
     * - {number} timeout: Maximum advertising time in limited discoverable mode. Required: a timeout must be provided.
     * - {boolean} connectable: GAP Advertising type connectable. Default: The device is connectable.
     * - {boolean} scannable: GAP Advertising type scannable. Default: The device is undirected.
     * @param {Object} options GAP advertising parameters.
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    startAdvertising(options, callback) {
        const advParams = this._getAdvertisementParams(options);

        this._adapter.gapStartAdvertising(advParams, err => {
            if (this._checkAndPropagateError(err, 'Failed to start advertising.', callback)) {
                return;
            }

            this._changeState({ advertising: true });
            if (_isCallback(callback)) {
                callback(undefined);
            }
        });
    }

    /**
     * @summary Set, clear or update advertising and scan response data.

     * The format of the advertising data will be checked by this call to ensure interoperability.
     * Limitations imposed by this API call to the data provided include having a flags data type in the scan response data and
     * duplicating the local name in the advertising data and scan response data.
     *
     * To clear the advertising data and set it to a 0-length packet, simply provide a null `advData`/`scanRespData` parameter.
     *
     * The call will fail if `advData` and `scanRespData` are both null since this would have no effect.
     *
     * See @ref: ./util/adType.js for possible advertisement object parameters.
     * @param {Object} advData Advertising packet
     * @param {Object} scanRespData Scan response packet.
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    setAdvertisingData(advData, scanRespData, callback) {
        const advDataStruct = Array.from(AdType.convertToBuffer(advData));
        const scanRespDataStruct = Array.from(AdType.convertToBuffer(scanRespData));

        this._adapter.gapSetAdvertisingData(advDataStruct, scanRespDataStruct, err => {
            if (this._checkAndPropagateError(err, 'Failed to set advertising data.', callback)) {
                return;
            }

            if (_isCallback(callback)) {
                callback();
            }
        });
    }

    /**
     * Stop advertising (GAP Discoverable, Connectable modes, Broadcast Procedure).
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    stopAdvertising(callback) {
        this._adapter.gapStopAdvertising(err => {
            if (this._checkAndPropagateError(err, 'Failed to stop advertising.', callback)) {
                return;
            }

            this._changeState({ advertising: false });
            if (_isCallback(callback)) {
                callback();
            }
        });
    }

    /**
     * @summary Disconnect (GAP Link Termination).

     * This call initiates the disconnection procedure, and its completion will be communicated to the application
     * with a `BLE_GAP_EVT_DISCONNECTED` event upon which `callback` will be called.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    disconnect(deviceInstanceId, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId, 'Failed to disconnect.', callback);
        if (!device) {
            return;
        }

        const hciStatusCode = this._bleDriver.BLE_HCI_REMOTE_USER_TERMINATED_CONNECTION;
        this._adapter.gapDisconnect(device.connectionHandle, hciStatusCode, err => {
            if (err) {
                const error = _makeError('Failed to disconnect', err);
                this.emit('error', error);

                if (_isCallback(callback)) {
                    callback(error);
                }
            } else {
                // expect a disconnect event down the road
                this._gapOperationsMap[deviceInstanceId] = { callback };
            }
        });
    }

    _getConnectionUpdateParams(options) {
        return {
            min_conn_interval: options.minConnectionInterval,
            max_conn_interval: options.maxConnectionInterval,
            slave_latency: options.slaveLatency,
            conn_sup_timeout: options.connectionSupervisionTimeout,
        };
    }

    /**
     * @summary Update connection parameters.
     *
     * In the central role this will initiate a Link Layer connection parameter update procedure,
     * otherwise in the peripheral role, this will send the corresponding L2CAP request and wait for
     * the central to perform the procedure. In both cases, and regardless of success or failure, the application
     * will be informed of the result with a `BLE_GAP_EVT_CONN_PARAM_UPDATE` event.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     *
     * Available GAP Connection Parameters:
     * - {number} min_conn_interval: Minimum Connection Interval in 1.25 ms units.
     * - {number} max_conn_interval:  Maximum Connection Interval in 1.25 ms units.
     * - {number} slave_latency: Slave Latency in number of connection events.
     * - {number} conn_sup_timeout: Connection Supervision Timeout in 10 ms units.
     * @param {Object} options GAP Connection Parameters.
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    updateConnectionParameters(deviceInstanceId, options, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId,
                                                            'Failed to update connection parameters.', callback);
        if (!device) {
            return;
        }

        const connectionParamsStruct = this._getConnectionUpdateParams(options);
        this._adapter.gapUpdateConnectionParameters(device.connectionHandle, connectionParamsStruct, err => {
            if (err) {
                const errorObject = _makeError('Failed to update connection parameters', err);
                
                this.emit('error', errorObject);
                if (_isCallback(callback)) {
                    callback(errorObject);
                }
            } else {
                this._gapOperationsMap[deviceInstanceId] = { callback };
            }
        });
    }

    /**
     * Reject a GAP connection parameters update request.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    rejectConnParams(deviceInstanceId, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId,
                                                            'Failed to reject connection parameters.', callback);
        if (!device) {
            return;
        }

        const connectionHandle = device.connectionHandle;
        // TODO: does the AddOn support undefined second parameter?
        this._adapter.gapUpdateConnectionParameters(connectionHandle, null, err => {
            if (this._checkAndPropagateError(err, 'Failed to reject connection parameters', callback)) {
                return;
            }

            if (_isCallback(callback)) {
                callback();
            }
        });
    }

    /**
     * Get the current ATT_MTU size.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @returns {undefined|number} The current ATT_MTU size.
     */
    getCurrentAttMtu(deviceInstanceId) {
        if (!(this._attMtuMap[deviceInstanceId])) {
            return;
        }

        return this._attMtuMap[deviceInstanceId];
    }

    /**
     * @summary Start an ATT_MTU exchange by sending an Exchange MTU Request to the server.
     *
     * The SoftDevice sets ATT_MTU to the minimum of:
     *     - The Client RX MTU value, and
     *     - The Server RX MTU value from `BLE_GATTC_EVT_EXCHANGE_MTU_RSP`.
     *
     *     However, the SoftDevice never sets ATT_MTU lower than `GATT_MTU_SIZE_DEFAULT` == 23.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {number} mtu Requested ATT_MTU. Default ATT_MTU is 23. Valid range is between 24 and 247.
     * @param {function} callback Callback signature: (err, mtu) => {}.
     * @returns {void}
     */
    requestAttMtu(deviceInstanceId, mtu, callback) {
        if (this._bleDriver.NRF_SD_BLE_API_VERSION <= 2) {
            if (_isCallback(callback)) {
                callback(undefined, this._bleDriver.GATT_MTU_SIZE_DEFAULT);
            }

            return;
        }

        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId, 'Failed to request att mtu.', callback);
        if (!device) {
            return;
        }

        if (this._gattOperationsMap[device.instanceId]) {
            const error = _makeError('Failed to request att mtu, a GATT operation is already in progress.');

            this.emit('error', error);
            if (_isCallback(callback)) {
                callback(error);
            }

            return;
        }

        this._adapter.gattcExchangeMtuRequest(device.connectionHandle, mtu, err => {
            if (err) {
                const error = _makeError('Failed to request att mtu', err);
                if (_isCallback(callback)) {
                    callback(error);
                }

                return;
            }

            this._gattOperationsMap[device.instanceId] = { callback, clientRxMtu: mtu };
        });
    }

    /**
     * @summary Initiate the GAP Authentication procedure.
     *
     * In the central role, this function will send an SMP Pairing Request (or an SMP Pairing Failed if rejected),
     * otherwise in the peripheral role, an SMP Security Request will be sent.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     *
     * Available GAP security parameters:
     * - {boolean} bond Perform bonding.
     * - {boolean} lesc Enable LE Secure Connection pairing.
     * - {boolean} keypress Enable generation of keypress notifications.
     * - {Object} io_caps IO capabilities, see @ref BLE_GAP_IO_CAPS.
     * - {boolean} oob Out Of Band data available.
     * - {number} min_key_size Minimum encryption key size in octets between 7 and 16. If 0 then not applicable in this instance.
     * - {number} max_key_size Maximum encryption key size in octets between min_key_size and 16.
     * - {Object} kdist_own Key distribution bitmap: keys that the local device will distribute.
     *                - {boolean} enc Long Term Key and Master Identification.
     *                - {boolean} id Identity Resolving Key and Identity Address Information.
     *                - {boolean} sign Connection Signature Resolving Key.
     *                - {boolean} link Derive the Link Key from the LTK.
     * - {Object} kdist_peer Key distribution bitmap: keys that the remote device will distribute.
     *                - ^^ Same as properties as `kdist_own` above. ^^
     * @param {object} secParams The security parameters to be used during the pairing or bonding procedure.
     *                           In the peripheral role, only the bond, mitm, lesc and keypress fields of this Object are used.
     *                           In the central role, this pointer may be NULL to reject a Security Request.
     *
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    authenticate(deviceInstanceId, secParams, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId, 'Failed to authenticate.', callback);
        if (!device) {
            return;
        }

        if (device.role === 'central') {
            device.ownPeriphInitiatedPairingPending = true;
        }

        this._adapter.gapAuthenticate(device.connectionHandle, secParams, err => {
            if (this._checkAndPropagateError(err, 'Failed to authenticate', callback)) {
                if (device.role === 'central') {
                    device.ownPeriphInitiatedPairingPending = false;
                }

                return;
            }

            if (_isCallback(callback)) {
                callback();
            }
        });
    }

    /**
     * @summary Reply with GAP security parameters.
     *
     * This function is only used to reply to a `BLE_GAP_EVT_SEC_PARAMS_REQUEST`, calling it at other times will result in an `NRF_ERROR_INVALID_STATE`.
     * If the call returns an error code, the request is still pending, and the reply call may be repeated with corrected parameters.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {string} secStatus Security status, see `BLE_GAP_SEC_STATUS`.
     * @param {Object} secParams Security parameters object. In the central role this must be set to null, as the parameters have
     *                           already been provided during a previous call to `this.authenticate()`.
     * @param {Object} secKeyset security key set object.
     *            - {Object} kdist_own Key distribution bitmap: keys that the local device will distribute.
     *                - {boolean} enc Long Term Key and Master Identification.
     *                - {boolean} id Identity Resolving Key and Identity Address Information.
     *                - {boolean} sign Connection Signature Resolving Key.
     *                - {boolean} link Derive the Link Key from the LTK.
     *            - {Object} kdist_peer Key distribution bitmap: keys that the remote device will distribute.
     *                - ^^ Same as properties as `kdist_own` above. ^^
     * @param {function} callback Callback signature: (err, secKeyset) => {}.
     * @returns {void}
     */
    replySecParams(deviceInstanceId, secStatus, secParams, secKeyset, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId,
                                                            'Failed to reply to security parameters.', callback);
        if (!device) {
            return;
        }

        this._adapter.gapReplySecurityParameters(device.connectionHandle, secStatus, secParams, secKeyset, (err, _secKeyset) => {
            if (this._checkAndPropagateError(err, 'Failed to reply security parameters.', callback)) {
                return;
            }

            if (_isCallback(callback)) {
                callback(undefined, _secKeyset);
            }
        });
    }

    /**
     * @summary Reply with an authentication key.
     *
     * This function is only used to reply to a `BLE_GAP_EVT_AUTH_KEY_REQUEST `or a `BLE_GAP_EVT_PASSKEY_DISPLAY`, calling it at other times will result in an `NRF_ERROR_INVALID_STATE`.
     * If the call returns an error code, the request is still pending, and the reply call may be repeated with corrected parameters.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {Object} keyType No key, 6-digit Passkey or Out Of Band data.
     * @param {null|Array|string} key If key type is `BLE_GAP_AUTH_KEY_TYPE_NONE`, then null.
     *                            If key type is `BLE_GAP_AUTH_KEY_TYPE_PASSKEY`, then a 6-byte array (digit 0..9 only)
     *                                or null when confirming LE Secure Connections Numeric Comparison.
     *                            If key type is `BLE_GAP_AUTH_KEY_TYPE_OOB`, then a 16-byte OOB key value in Little Endian format.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    replyAuthKey(deviceInstanceId, keyType, key, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId,
                                                            'Failed to reply authenticate key.', callback);
        if (!device) {
            return;
        }

        // If the key is a string we split it into an array before we call gapReplyAuthKey
        if (key && key.constructor === String) {
            key = Array.from(key);
        }

        this._adapter.gapReplyAuthKey(device.connectionHandle, keyType, key, err => {
            if (this._checkAndPropagateError(err, 'Failed to reply authenticate key.', callback)) {
                return;
            }

            if (_isCallback(callback)) {
                callback();
            }
        });
    }

    /**
     * @summary Reply with an LE Secure connections DHKey.
     *
     * This function is only used to reply to a `BLE_GAP_EVT_LESC_DHKEY_REQUEST`, calling it at other times will result in an `NRF_ERROR_INVALID_STATE`.
     * If the call returns an error code, the request is still pending, and the reply call may be repeated with corrected parameters.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {Object} dhkey LE Secure Connections DHKey.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    replyLescDhkey(deviceInstanceId, dhkey, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId, 'Failed to reply lesc dh key.', callback);
        if (!device) {
            return;
        }

        this._adapter.gapReplyLescDhKey(device.connectionHandle, dhkey, err => {
            if (this._checkAndPropagateError(err, 'Failed to reply lesc dh key.', callback)) {
                return;
            }

            if (_isCallback(callback)) {
                callback();
            }
        });
    }

    /**
     * @summary Notify the peer of a local keypress.
     *
     * This function can only be used when an authentication procedure using LE Secure Connection is in progress. Calling it at other times will result in an `NRF_ERROR_INVALID_STATE`.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {number} notificationType See `adapter.driver.BLE_GAP_KP_NOT_TYPES`.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    notifyKeypress(deviceInstanceId, notificationType, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId, 'Failed to notify keypress.', callback);
        if (!device) {
            return;
        }

        this._adapter.gapNotifyKeypress(device.connectionHandle, notificationType, err => {
            if (this._checkAndPropagateError(err, 'Failed to notify keypress.', callback)) {
                return;
            }

            if (_isCallback(callback)) {
                callback();
            }
        });
    }

    /**
     * @summary Generate a set of OOB data to send to a peer out of band.
     *
     * The `ble_gap_addr_t` included in the OOB data returned will be the currently active one (or, if a connection has already been established,
     * the one used during connection setup). The application may manually overwrite it with an updated value.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {string} ownPublicKey LE Secure Connections local P-256 Public Key.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    getLescOobData(deviceInstanceId, ownPublicKey, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId, 'Failed to get lesc oob data.', callback);
        if (!device) {
            return;
        }

        this._adapter.gapGetLescOobData(device.connectionHandle, ownPublicKey, (err, ownOobData) => {
            if (this._checkAndPropagateError(err, 'Failed to get lesc oob data', callback)) {
                return;
            }

            if (_isCallback(callback)) {
                callback(undefined, ownOobData);
            }
        });
    }

    /**
     * @summary Provide the OOB data sent/received out of band.
     *
     * At least one of the 2 data objects provided must not be null.
     * An authentication procedure with OOB selected as an algorithm must be in progress when calling this function.
     * A `BLE_GAP_EVT_LESC_DHKEY_REQUEST` event with the oobd_req set to 1 must have been received prior to calling this function.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {string} ownOobData The OOB data sent out of band to a peer or NULL if none sent.
     * @param {string} peerOobData The OOB data received out of band from a peer or NULL if none received.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    setLescOobData(deviceInstanceId, ownOobData, peerOobData, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId, 'Failed to set lesc oob data.', callback);
        if (!device) {
            return;
        }

        this._adapter.gapSetLescOobData(device.connectionHandle, ownOobData, peerOobData, err => {
            if (this._checkAndPropagateError(err, 'Failed to set lesc oob data.', callback)) {
                return;
            }

            if (_isCallback(callback)) {
                callback();
            }
        });
    }


    /**
     * @summary Initiate GAP Encryption procedure.
     *
     * In the central role, this function will initiate the encryption procedure using the encryption information provided.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {Object} masterId Master identification structure. TODO
     * @param {Object} encInfo Encryption information structure. TODO
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    encrypt(deviceInstanceId, masterId, encInfo, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId, 'Failed to encrypt.', callback);
        if (!device) {
            return;
        }

        this._adapter.gapEncrypt(device.connectionHandle, masterId, encInfo, err => {
            if (this._checkAndPropagateError(err, 'Failed to encrypt.', callback)) {
                return;
            }

            if (_isCallback(callback)) {
                callback();
            }
        });
    }

    /**
     * @summary Reply with GAP security information.
     *
     * This function is only used to reply to a `BLE_GAP_EVT_SEC_INFO_REQUEST`, calling it at other times will result in `NRF_ERROR_INVALID_STATE`.
     * If the call returns an error code, the request is still pending, and the reply call may be repeated with corrected parameters.
     * Data signing is not yet supported, and signInfo must therefore be null.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {Object} encInfo Encryption information structure. May be null to signal none is available.
     * @param {Object} idInfo Identity information structure. May be null to signal none is available.
     * @param {Object} signInfo Pointer to a signing information structure. May be null to signal none is available.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    secInfoReply(deviceInstanceId, encInfo, idInfo, signInfo, callback) {
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId, 'secInfoReply() failed.', callback);
        if (!device) {
            return;
        }

        this._adapter.gapReplySecurityInfo(device.connectionHandle, encInfo, idInfo, signInfo, err => {
            let errorObject;

            if (err) {
                errorObject = _makeError('secInfoReply() failed.', err);
                this.emit('error', errorObject);
            }

            if (_isCallback(callback)) {
                callback(errorObject);
            }
        });
    }

    /**
     * Set the services in the BLE peripheral device's GATT attribute table.
     *
     * @param {[Service]} services An array of `Service` objects to be set.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    setServices(services, callback) {
        const decodeUUID = (uuid, data) => {
            return new Promise((resolve, reject) => {
                const length = uuid.length === 32 ? 16 : 2;

                this._adapter.decodeUUID(length, uuid, (err, _uuid) => {
                    if (err) {
                        // If the UUID is not found it is a 128-bit UUID
                        // so we have to add it to the SD and try again
                        if (err.errno === this._bleDriver.NRF_ERROR_NOT_FOUND && length === 16) {
                            this._adapter.addVendorspecificUUID(
                                { uuid128: uuid },
                                (err, type) => {
                                    if (err) {
                                        reject(_makeError(`Unable to add UUID ${uuid} to SoftDevice`, err));
                                    } else {
                                        this._adapter.decodeUUID(length, uuid, (err, _uuid) => {
                                            if (err) {
                                                reject(_makeError(`Unable to decode UUID ${uuid}`, err));
                                            } else {
                                                data.decoded_uuid = _uuid;
                                                resolve(data);
                                            }
                                        });
                                    }
                                }
                            );
                        } else {
                            reject(_makeError(`Unable to decode UUID ${uuid}`, err));
                        }
                    } else {
                        data.decoded_uuid = _uuid;
                        resolve(data);
                    }
                });
            });
        };

        const addService = (service, type, data) => {
            return new Promise((resolve, reject) => {
                let p = Promise.resolve(data);
                const decode = decodeUUID.bind(undefined, service.uuid);

                p.then(decode).then(data => {
                    this._adapter.gattsAddService(type, data.decoded_uuid, (err, serviceHandle) => {
                        if (err) {
                            reject(_makeError('Error occurred adding service.', err));
                        } else {
                            data.serviceHandle = serviceHandle;
                            service.startHandle = serviceHandle;
                            this._services[service.instanceId] = service; // TODO: what if we fail later on this service ?
                            resolve(data);
                        }
                    });
                }).catch(err => {
                    reject(err);
                });
            });
        };

        const addCharacteristic = (characteristic, data) => {
            return new Promise((resolve, reject) => {
                this._converter.characteristicToDriver(characteristic, (err, characteristicForDriver) => {
                    if (err) {
                        reject(_makeError('Error converting characteristic to driver.', err));
                    } else {
                        this._adapter.gattsAddCharacteristic(
                            data.serviceHandle,
                            characteristicForDriver.metadata,
                            characteristicForDriver.attribute,
                            (err, handles) => {
                                if (err) {
                                    reject(_makeError('Error occurred adding characteristic.', err));
                                } else {
                                    characteristic.valueHandle = data.characteristicHandle = handles.value_handle;
                                    characteristic.declarationHandle = characteristic.valueHandle - 1; // valueHandle is always directly after declarationHandle
                                    this._characteristics[characteristic.instanceId] = characteristic; // TODO: what if we fail later on this ?
                                    resolve(data);

                                    if (!characteristic._factory_descriptors) {
                                        return;
                                    }

                                    const findDescriptor = uuid => {
                                        return characteristic._factory_descriptors.find(descriptor => {
                                            return descriptor.uuid === uuid;
                                        });
                                    };

                                    if (handles.user_desc_handle) {
                                        const userDescriptionDescriptor = findDescriptor('2901');
                                        this._descriptors[userDescriptionDescriptor.instanceId] = userDescriptionDescriptor;
                                        userDescriptionDescriptor.handle = handles.user_desc_handle;
                                    }

                                    if (handles.cccd_handle) {
                                        const cccdDescriptor = findDescriptor('2902');
                                        this._descriptors[cccdDescriptor.instanceId] = cccdDescriptor;
                                        cccdDescriptor.handle = handles.cccd_handle;
                                        cccdDescriptor.value = {};

                                        for (const deviceInstanceId in this._devices) {
                                            if (Object.prototype.hasOwnProperty.call(this._devices, deviceInstanceId) ||
                                                {}.hasOwnProperty.call(this._devices, deviceInstanceId)) {
                                                this._setDescriptorValue(cccdDescriptor, [0, 0], deviceInstanceId);
                                            }
                                        }
                                    }

                                    if (handles.sccd_handle) {
                                        const sccdDescriptor = findDescriptor('2903');
                                        this._descriptors[sccdDescriptor.instanceId] = sccdDescriptor;
                                        sccdDescriptor.handle = handles.sccd_handle;
                                    }
                                }
                            }
                        );
                    }
                });
            });
        };

        const addDescriptor = (descriptor, data) => {
            return new Promise((resolve, reject) => {
                this._converter.descriptorToDriver(descriptor, (err, descriptorForDriver) => {
                    if (err) {
                        reject(_makeError('Error converting descriptor.', err));
                    } else if (descriptorForDriver) {
                        this._adapter.gattsAddDescriptor(data.characteristicHandle, descriptorForDriver,
                            (err, handle) => {
                                if (err) {
                                    reject(_makeError(err, 'Error adding descriptor.'));
                                } else {
                                    descriptor.handle = data.descriptorHandle = handle;
                                    this._descriptors[descriptor.instanceId] = descriptor; // TODO: what if we fail later on this ?
                                    resolve(data);
                                }
                            }
                        );
                    }
                });
            });
        };

        const promiseSequencer = (list, data) => {
            const p = Promise.resolve(data);
            return list.reduce((previousP, nextP) => {
                return previousP.then(nextP);
            }, p);
        };

        const applyGapServiceCharacteristics = gapService => {
            for (const characteristic of gapService._factory_characteristics) {
                // TODO: Fix Device Name uuid magic number
                if (characteristic.uuid === '2A00') {
                    // TODO: At some point addon should accept string.
                    this._setDeviceNameFromArray(characteristic.value, characteristic.writePerm, err => {
                        if (!err) {
                            characteristic.declarationHandle = 2;
                            characteristic.valueHandle = 3;
                            this._characteristics[characteristic.instanceId] = characteristic;
                        }
                    });
                }

                // TODO: Fix Appearance uuid magic number
                if (characteristic.uuid === '2A01') {
                    this._setAppearanceFromArray(characteristic.value, err => {
                        if (!err) {
                            characteristic.declarationHandle = 4;
                            characteristic.valueHandle = 5;
                            this._characteristics[characteristic.instanceId] = characteristic;
                        }
                    });
                }

                // TODO: Fix Peripheral Preferred Connection Parameters uuid magic number
                if (characteristic.uuid === '2A04') {
                    this._setPPCPFromArray(characteristic.value, err => {
                        if (!err) {
                            characteristic.declarationHandle = 6;
                            characteristic.valueHandle = 7;
                            this._characteristics[characteristic.instanceId] = characteristic;
                        }
                    });
                }
            }
        };

        // Create array of function objects to call in sequence.
        let promises = [];

        for (const service of services) {
            let p;

            if (service.uuid === '1800') {
                service.startHandle = 1;
                service.endHandle = 7;
                applyGapServiceCharacteristics(service);
                this._services[service.instanceId] = service;
            } else if (service.uuid === '1801') {
                service.startHandle = 8;
                service.endHandle = 8;
                this._services[service.instanceId] = service;
            } else {
                p = addService.bind(undefined, service, this._getServiceType(service));
                promises.push(p);

                if (service._factory_characteristics) {
                    for (const characteristic of service._factory_characteristics) {
                        p = addCharacteristic.bind(undefined, characteristic);
                        promises.push(p);

                        if (characteristic._factory_descriptors) {
                            for (const descriptor of characteristic._factory_descriptors) {
                                if (!this._converter.isSpecialUUID(descriptor.uuid)) {
                                    p = addDescriptor.bind(undefined, descriptor);
                                    promises.push(p);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Execute the promises in sequence, start with an empty object that
        // is propagated to all promises.
        promiseSequencer(promises, {}).then(data => {
            // TODO: Ierate over all servicses, descriptors, characterstics from parameter services
            if (_isCallback(callback)) {
                callback();
            }
        }).catch(err => {
            this.emit('error', err);
            if (_isCallback(callback)) {
                callback(err);
            }
        });
    }

    /**
     * Get a `Service` instance by its instanceId.
     *
     * @param {string} serviceInstanceId The unique Id of this service.
     * @returns {Service} The service.
     */
    getService(serviceInstanceId) {
        // TODO: Do read on service? callback?
        return this._services[serviceInstanceId];
    }

    /**
     * Initiate or continue a GATT Primary Service Discovery procedure.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {function} callback Callback signature: (err, services) => {}.
     * @returns {void}
     */
    getServices(deviceInstanceId, callback) {
        // TODO: implement something for when device is local
        const device = this._getDeviceByIdAndPropagateError(deviceInstanceId, 'Failed to get services.', callback);
        if (!device) {
            return;
        }

        if (this._gattOperationsMap[device.instanceId]) {
            this._checkAndPropagateError('A GATT operation already in progress.', 'Failed to get services.', callback);
            return;
        }

        // TODO: should we remove old services and do new discovery?
        const alreadyFoundServices = _.filter(this._services, service => {
            return deviceInstanceId === service.deviceInstanceId;
        });

        if (!_.isEmpty(alreadyFoundServices)) {
            if (_isCallback(callback)) {
                callback(undefined, alreadyFoundServices);
            }

            return;
        }

        // TODO: we register callback here but then are also calling it upon success with `services` is this correct?
        this._gattOperationsMap[device.instanceId] = { callback, pendingHandleReads: {}, parent: device };
        this._adapter.gattcDiscoverPrimaryServices(device.connectionHandle, 1, null, (err, services) => {
            if (err) {
                this.emit('error', _makeError('Failed to get services', err));
                if (_isCallback(callback)) {
                    callback(err);
                }
            } else if (_isCallback(callback)) {
                callback(undefined, services);
            }
        });
    }

    /**
     * Get a `Characteristic` instance by its instanceId.
     *
     * @param {string} characteristicId The unique Id of this characteristic.
     * @returns {Characteristic} The characteristic.
     */
    getCharacteristic(characteristicId) {
        return this._characteristics[characteristicId];
    }

    /**
     * Initiate or continue a GATT Characteristic Discovery procedure.
     *
     *
     * @param {string} serviceId Unique ID of of the GATT service.
     * @param {function} callback Callback signature: (err, characteristics) => {}.
     * @returns {void}
     */
    getCharacteristics(serviceId, callback) {
        // TODO: Implement something for when device is local
        const service = this.getService(serviceId);
        if (!service) {
            throw _makeError('Failed to get characteristics', `Could not find service with Id: ${serviceId}.`);
        }

        const device = this._getDeviceByIdAndPropagateError(service.deviceInstanceId,
                                                            'Failed to get characteristics.', callback);
        if (!device) {
            return;
        }

        if (this._gattOperationsMap[device.instanceId]) {
            this._checkAndPropagateError('Failed to get characteristics',
                                         'A GATT operation already in progress', callback);
            return;
        }

        const alreadyFoundCharacteristics = _.filter(this._characteristics, characteristic => {
            return serviceId === characteristic.serviceInstanceId;
        });

        if (!_.isEmpty(alreadyFoundCharacteristics)) {
            if (_isCallback(callback)) {
                callback(undefined, alreadyFoundCharacteristics);
            }
            return;
        }

        const handleRange = {
            start_handle: service.startHandle,
            end_handle: service.endHandle,
        };

        this._gattOperationsMap[device.instanceId] = { callback, pendingHandleReads: {}, parent: service };
        this._adapter.gattcDiscoverCharacteristics(device.connectionHandle, handleRange, err => {
            this._checkAndPropagateError(err, 'Failed to get Characteristics', callback);
        });
    }

    /**
     * Get a `Descriptor` instance by its instanceId.
     *
     * @param {string} descriptorId The unique Id of this descriptor.
     * @returns {Descriptor} The descriptor.
     */
    getDescriptor(descriptorId) {
        return this._descriptors[descriptorId];
    }

    _isDescriptorPerConnectionBased(descriptor) {
        return this._isCCCDDescriptor(descriptor.instanceId);
    }

    _setDescriptorValue(descriptor, value, deviceInstanceId) {
        if (this._isDescriptorPerConnectionBased(descriptor)) {
            descriptor.value[deviceInstanceId] = value;
        } else {
            descriptor.value = value;
        }
    }

    _getDescriptorValue(descriptor, deviceInstanceId) {
        if (this._isDescriptorPerConnectionBased(descriptor)) {
            return descriptor.value[deviceInstanceId];
        }

        return descriptor.value;
    }

    _addDeviceToAllPerConnectionValues(deviceId) {
        for (const descriptorInstanceId in this._descriptors) {
            if (Object.prototype.hasOwnProperty.call(this._descriptors, descriptorInstanceId) ||
                {}.hasOwnProperty.call(this._descriptors, descriptorInstanceId)) {
                const descriptor = this._descriptors[descriptorInstanceId];
                if (this._instanceIdIsOnLocalDevice(descriptorInstanceId) &&
                    this._isDescriptorPerConnectionBased(descriptor)) {
                    this._setDescriptorValue(descriptor, [0, 0], deviceId);
                    this.emit('descriptorValueChanged', descriptor);
                }
            }
        }
    }

    _clearDeviceFromAllPerConnectionValues(deviceId) {
        for (const descriptorInstanceId in this._descriptors) {
            if (Object.prototype.hasOwnProperty.call(this._descriptors, descriptorInstanceId) ||
                {}.hasOwnProperty.call(this._descriptors, descriptorInstanceId)) {
                const descriptor = this._descriptors[descriptorInstanceId];
                if (this._instanceIdIsOnLocalDevice(descriptorInstanceId) &&
                    this._isDescriptorPerConnectionBased(descriptor)) {
                    delete descriptor.value[deviceId];
                    this.emit('descriptorValueChanged', descriptor);
                }
            }
        }
    }

    _clearDeviceFromDiscoveredServices(deviceId) {
        this._services = this._filterObject(this._services, value => value.indexOf(deviceId) < 0);
        this._characteristics = this._filterObject(this._characteristics, value => value.indexOf(deviceId) < 0);
        this._descriptors = this._filterObject(this._descriptors, value => value.indexOf(deviceId) < 0);
    }

    _filterObject(collection, predicate) {
        const newCollection = {};

        for (const key in collection) {
            if (predicate(key)) {
                newCollection[key] = collection[key];
            }
        }

        return newCollection;
    }

    /**
     * Initiate or continue a GATT Characteristic Descriptor Discovery procedure.
     *
     * @param {string} characteristicId Unique ID of of the GATT characteristic.
     * @param {function} callback Callback signature: (err, descriptors) => {}.
     * @returns {void}
     */
    getDescriptors(characteristicId, callback) {
        const characteristic = this.getCharacteristic(characteristicId);
        const service = this.getService(characteristic.serviceInstanceId);

        const device = this._getDeviceByIdAndPropagateError(service.deviceInstanceId,
            'Failed to get descriptors.', callback);
        if (!device) {
            return;
        }

        if (this._gattOperationsMap[device.instanceId]) {
            this._checkAndPropagateError('Failed to get descriptors',
                                         'A GATT operation already in progress', callback);
            return;
        }

        const alreadyFoundDescriptor = _.filter(this._descriptors, descriptor => {
            return characteristicId === descriptor.characteristicInstanceId;
        });

        if (!_.isEmpty(alreadyFoundDescriptor)) {
            if (_isCallback(callback)) {
                callback(undefined, alreadyFoundDescriptor);
            }
            return;
        }

        const handleRange = { start_handle: characteristic.valueHandle + 1, end_handle: service.endHandle };
        this._gattOperationsMap[device.instanceId] = { callback, pendingHandleReads: {}, parent: characteristic };
        this._adapter.gattcDiscoverDescriptors(device.connectionHandle, handleRange, err => {
            if (_isCallback(callback)) {
                callback(err);
            }
            // this._checkAndPropagateError('Failed to get descriptors', err, callback);
        });
    }

    _getDescriptorsPromise() {
        return (data, serviceId, characteristicId) => {
            return new Promise((resolve, reject) => {
                this.getDescriptors(
                    characteristicId, (error, descriptors) => {
                        if (error) {
                            return reject(error);
                        }

                        data.services[serviceId].characteristics[characteristicId].descriptors = descriptors;
                        resolve(data);
                    }
                );
            });
        };
    }

    _getCharacteristicsPromise() {
        return (data, service) => {
            return new Promise((resolve, reject) => {
                this.getCharacteristics(service.instanceId, (error, characteristics) => {
                    if (error) {
                        return reject(error);
                    }

                    data.services[service.instanceId].characteristics = {};
                    let promise = Promise.resolve(data);

                    for (const characteristic of characteristics) {
                        data.services[service.instanceId].characteristics[characteristic.instanceId] = characteristic;

                        promise = promise.then(data => {
                            return this._getDescriptorsPromise()(
                                data,
                                service.instanceId,
                                characteristic.instanceId);
                        });
                    }

                    promise.then(data => {
                        resolve(data);
                    }).catch(error => {
                        reject(error);
                    });
                });
            });
        };
    }

    _getServicesPromise(deviceInstanceId) {
        return new Promise((resolve, reject) => {
            this.getServices(
                deviceInstanceId,
                (error, services) => {
                    if (error) {
                        return reject(error);
                    }

                    resolve(services);
                });
        });
    }

    /**
     * Discovers information about a range of attributes on a GATT server.
     *
     * @param {string} deviceInstanceId The device's unique Id.
     * @param {function} callback Callback signature: (err, attributes) => {}.
     * @returns {void}
     */
    getAttributes(deviceInstanceId, callback) {
        const data = { services: {} };

        this._getServicesPromise(deviceInstanceId).then(services => {
            let p = Promise.resolve(data);

            for (const service of services) {
                data.services[service.instanceId] = service;

                p = p.then(_data => {
                    return this._getCharacteristicsPromise()(_data, service);
                });
            }

            return p;
        })
        // TODO: no descriptors?
        .then(_data => {
            if (_isCallback(callback)) {
                callback(undefined, _data);
            }
        })
        .catch(error => {
            if (_isCallback(callback)) {
                callback(error);
            }
        });
    }

    /**
     * Reads the value of a GATT characteristic.
     *
     * @param {string} characteristicId Unique ID of of the GATT characteristic.
     * @param {function} callback Callback signature: (err, readBytes) => {}.
     * @returns {void}
     */
    readCharacteristicValue(characteristicId, callback) {
        const characteristic = this.getCharacteristic(characteristicId);
        if (!characteristic) {
            throw new Error(`Characteristic write failed: 
                             Could not get the characteristic with Id: ${characteristicId}.`);
        }

        if (this._instanceIdIsOnLocalDevice(characteristicId)) {
            this._readLocalValue(characteristic, callback);
            return;
        }

        const device = this._getDeviceByCharacteristicId(characteristicId);
        if (!device) {
            throw new Error('Characteristic write failed: Could not get device.');
        }

        if (this._gattOperationsMap[device.instanceId]) {
            throw new Error(`Characteristic read failed:
                             A GATT operation is already in progress with device with Id: ${device.instanceId}.`);
        }

        this._gattOperationsMap[device.instanceId] = { callback, readBytes: [] };

        this._adapter.gattcRead(device.connectionHandle, characteristic.valueHandle, 0, err => {
            if (err) {
                this.emit('error', _makeError('Characteristic read failed', err));
            }
        });
    }

    /**
     * Writes the value of a GATT characteristic.
     *
     * @param {string} characteristicId Unique ID of the GATT characteristic.
     * @param {array} value The value (array of bytes) to be written.
     * @param {boolean} ack Require acknowledge from device, irrelevant in GATTS role.
     * @param {function} completeCallback Callback signature: err => {}
     * @param {function} deviceNotifiedOrIndicated TODO
     * @returns {void}
     */
    writeCharacteristicValue(characteristicId, value, ack, completeCallback, deviceNotifiedOrIndicated) {
        const characteristic = this.getCharacteristic(characteristicId);
        if (!characteristic) {
            throw new Error(`Characteristic write failed: 
                             Could not get the characteristic with Id: ${characteristicId}.`);
        }

        if (this._instanceIdIsOnLocalDevice(characteristicId)) {
            this._writeLocalValue(characteristic, value, 0, completeCallback, deviceNotifiedOrIndicated);
            return;
        }

        const device = this._getDeviceByCharacteristicId(characteristicId);
        if (!device) {
            throw new Error('Characteristic write failed: Could not get device.');
        }

        if (this._gattOperationsMap[device.instanceId]) {
            throw new Error(`Characteristic write failed:
                             A GATT operation is already in progress with device with Id: ${device.instanceId}.`);
        }

        this._gattOperationsMap[device.instanceId] = {
            callback: completeCallback,
            bytesWritten: 0,
            value: value.slice(),
            attribute: characteristic,
        };

        if (value.length > this._maxShortWritePayloadSize(device.instanceId)) {
            if (!ack) {
                throw new Error('Long writes do not support BLE_GATT_OP_WRITE_CMD.');
            }

            this._gattOperationsMap[device.instanceId].bytesWritten = this._maxLongWritePayloadSize(device.instanceId);
            this._longWrite(device, characteristic, value, completeCallback);
        } else {
            this._gattOperationsMap[device.instanceId].bytesWritten = value.length;
            this._shortWrite(device, characteristic, value, ack, completeCallback);
        }
    }

    _getDeviceByDescriptorId(descriptorId) {
        const descriptor = this._descriptors[descriptorId];
        if (!descriptor) {
            throw new Error(`No descriptor found with Id: ${descriptorId}.`);
        }

        return this._getDeviceByCharacteristicId(descriptor.characteristicInstanceId);
    }

    _getDeviceByCharacteristicId(characteristicId) {
        const characteristic = this._characteristics[characteristicId];
        if (!characteristic) {
            throw new Error(`No characteristic found with Id: ${characteristicId}.`);
        }

        const service = this._services[characteristic.serviceInstanceId];
        if (!service) {
            throw new Error(`No service found with Id: ${characteristic.serviceInstanceId}.`);
        }

        const device = this._devices[service.deviceInstanceId];
        if (!device) {
            throw new Error(`No device found with id: ${service.deviceInstanceId}.`);
        }

        return device;
    }

    _isCCCDDescriptor(descriptorId) {
        const descriptor = this._descriptors[descriptorId];
        return descriptor && (descriptor.uuid === '0000290200001000800000805F9B34FB' || descriptor.uuid === '2902');
    }

    _getCCCDOfCharacteristic(characteristicId) {
        return _.find(this._descriptors, descriptor => {
            return descriptor.characteristicInstanceId === characteristicId &&
                this._isCCCDDescriptor(descriptor.instanceId);
        });
    }

    _instanceIdIsOnLocalDevice(instanceId) {
        return instanceId.split('.')[0] === 'local';
    }

    /**
     * Reads the value of a GATT descriptor.
     *
     * @param {string} descriptorId Unique ID of of the GATT descriptor.
     * @param {function} callback Callback signature: (err, readBytes) => {}.
     * @returns {void}
     */
    readDescriptorValue(descriptorId, callback) {
        const descriptor = this.getDescriptor(descriptorId);
        if (!descriptor) {
            throw new Error(`Descriptor read failed: Could not get the descriptor with Id: ${descriptorId}.`);
        }

        if (this._instanceIdIsOnLocalDevice(descriptorId)) {
            this._readLocalValue(descriptor, callback);
            return;
        }

        const device = this._getDeviceByDescriptorId(descriptorId);
        if (!device) {
            throw new Error('Descriptor read failed: Could not get device.');
        }

        if (this._gattOperationsMap[device.instanceId]) {
            throw new Error(`Descriptor read failed:
                             A GATT operation is already in progress with device with Id: ${device.instanceId}.`);
        }

        this._gattOperationsMap[device.instanceId] = { callback, readBytes: [] };

        this._adapter.gattcRead(device.connectionHandle, descriptor.handle, 0, err => {
            if (err) {
                this.emit('error', _makeError('Read descriptor value failed', err));
            }
        });
    }

    /**
     * Writes the value of a GATT descriptor.
     *
     * @param {string} descriptorId Unique ID of the GATT descriptor.
     * @param {array} value The value (array of bytes) to be written.
     * @param {boolean} ack Require acknowledge from device, irrelevant in GATTS role.
     * @param {function} callback Callback signature: err => {}. (not called until ack is received if `requireAck`).
     *                            options: {ack, long, offset}
     * @returns {void}
     */
    writeDescriptorValue(descriptorId, value, ack, callback) {
        // Does not support reliable write
        const descriptor = this.getDescriptor(descriptorId);
        if (!descriptor) {
            throw new Error(`Descriptor write failed: Could not get the descriptor with Id: ${descriptorId}.`);
        }

        if (this._instanceIdIsOnLocalDevice(descriptorId)) {
            this._writeLocalValue(descriptor, value, 0, callback);
            return;
        }

        const device = this._getDeviceByDescriptorId(descriptorId);
        if (!device) {
            throw new Error('Descriptor write failed: Could not get device.');
        }

        if (this._gattOperationsMap[device.instanceId]) {
            throw new Error(`Descriptor write failed:
                             A GATT operation is already in progress with device with Id: ${device.instanceId}.`);
        }

        this._gattOperationsMap[device.instanceId] = {
            callback,
            bytesWritten: 0,
            value: value.slice(),
            attribute: descriptor,
        };

        if (value.length > this._maxShortWritePayloadSize(device.instanceId)) {
            if (!ack) {
                throw new Error('Long writes do not support BLE_GATT_OP_WRITE_CMD.');
            }

            this._gattOperationsMap[device.instanceId].bytesWritten = this._maxLongWritePayloadSize(device.instanceId);
            this._longWrite(device, descriptor, value, callback);
        } else {
            this._gattOperationsMap[device.instanceId].bytesWritten = value.length;
            this._shortWrite(device, descriptor, value, ack, callback);
        }
    }

    _shortWrite(device, attribute, value, ack, callback) {
        const writeParameters = {
            write_op: ack ? this._bleDriver.BLE_GATT_OP_WRITE_REQ : this._bleDriver.BLE_GATT_OP_WRITE_CMD,
            flags: 0, // don't care for WRITE_REQ/WRITE_CMD
            handle: attribute.handle,
            offset: 0,
            len: value.length,
            value,
        };

        this._gattcWriteWithRetries(device.connectionHandle, writeParameters, err => {
            if (err) {
                delete this._gattOperationsMap[device.instanceId];

                this.emit('error', _makeError(`Failed to write attribute with handle: ${attribute.handle}`, err));
                if (_isCallback(callback)) {
                    callback(err);
                }

                return;
            }

            if (!ack) {
                delete this._gattOperationsMap[device.instanceId];

                attribute.value = value;

                if (_isCallback(callback)) {
                    callback(undefined, attribute);
                }
            }
        });
    }

    _gattcWriteWithRetries(connectionHandle, writeParameters, callback) {
        let attempts = 0;

        const MAX_ATTEMPTS = 20;
        const RETRY_DELAY = 5;
        const BLE_ERROR_NO_TX_PACKETS = 0x3004;

        const tryWrite = () => {
            this._adapter.gattcWrite(connectionHandle, writeParameters, err => {
                if (err) {
                    attempts += 1;

                    if (err.errno === BLE_ERROR_NO_TX_PACKETS && attempts <= MAX_ATTEMPTS) {
                        setTimeout(() => tryWrite(), RETRY_DELAY);
                    } else if (_isCallback(callback)) {
                        callback(err);
                    }
                } else if (_isCallback(callback)) {
                    callback();
                }
            });
        };

        tryWrite();
    }

    _longWrite(device, attribute, value, callback) {
        if (value.length < this._maxShortWritePayloadSize(device.instanceId)) {
            throw new Error(`Wrong write method. Use regular write for payload sizes < 
                            ${this._maxShortWritePayloadSize(device.instanceId)}.`);
        }

        const writeParameters = {
            write_op: this._bleDriver.BLE_GATT_OP_PREP_WRITE_REQ,
            flags: this._bleDriver.BLE_GATT_EXEC_WRITE_FLAG_PREPARED_WRITE,
            handle: attribute.handle,
            offset: 0,
            len: this._maxLongWritePayloadSize(device.instanceId),
            value: value.slice(0, this._maxLongWritePayloadSize(device.instanceId)),
        };

        this._adapter.gattcWrite(device.connectionHandle, writeParameters, err => {
            if (err) {
                this._longWriteCancel(device, attribute);

                this.emit('error', _makeError(`Failed to long write value of device/handle: 
                                               ${device.instanceId}/'${attribute.handle}.`, err));
                if (_isCallback(callback)) {
                    callback(err);
                }
            }
        });
    }

    _longWriteCancel(device, attribute) {
        const gattOperation = this._gattOperationsMap[device.instanceId];
        const writeParameters = {
            write_op: this._bleDriver.BLE_GATT_OP_EXEC_WRITE_REQ,
            flags: this._bleDriver.BLE_GATT_EXEC_WRITE_FLAG_PREPARED_CANCEL,
            handle: attribute.handle,
            offset: 0,
            len: 0,
            value: [],
        };

        this._adapter.gattcWrite(device.connectionHandle, writeParameters, err => {
            delete this._gattOperationsMap[device.instanceId];

            if (err) {
                this.emit('error', _makeError('Failed to cancel failed long write.', err));
                gattOperation.callback('Failed to write and failed to cancel the failed long write.');
            } else {
                gattOperation.callback(`Failed to long write value of device/handle: 
                                        ${device.instanceId}/${attribute.handle}.`);
            }
        });
    }

    _sendingNotificationsAndIndicationsComplete() {
        return this._pendingNotificationsAndIndications.sentAllNotificationsAndIndications &&
            this._pendingNotificationsAndIndications.remainingNotificationCallbacks === 0 &&
            this._pendingNotificationsAndIndications.remainingIndicationConfirmations === 0;
    }

    _writeLocalValue(attribute, value, offset, completeCallback, deviceNotifiedOrIndicated) {
        const writeParameters = { len: value.length, offset, value };

        if (!this._instanceIdIsOnLocalDevice(attribute.instanceId)) {
            this.emit('error', _makeError('Attribute was not a local attribute'));
            return;
        }

        // TODO: Do we know that the attributes are the correct attributes?
        if (attribute.uuid === '2A00') {
            // TODO: At some point addon should accept string.
            // TODO: Fix write perm to be same as set at server setup.
            this._setDeviceNameFromArray(value, ['open'], err => {
                if (err) {
                    completeCallback(err);
                }

                attribute.value = value;
                completeCallback(undefined, attribute);
            });
            return;
        }

        // TODO: Fix Appearance uuid magic number
        if (attribute.uuid === '2A01') {
            this._setAppearanceFromArray(value, err => {
                if (err) {
                    completeCallback(err);
                }

                attribute.value = value;
                completeCallback(undefined, attribute);
            });
            return;
        }

        // TODO: Fix Peripheral Preferred Connection Parameters uuid magic number
        if (attribute.uuid === '2A04') {
            this._setPPCPFromArray(value, err => {
                if (err) {
                    completeCallback(err);
                }

                attribute.value = value;
                completeCallback(undefined, attribute);
            });
            return;
        }

        // TODO: Figure out if we should use hvx?
        const cccdDescriptor = this._getCCCDOfCharacteristic(attribute.instanceId);
        let sentHvx = false;

        if (cccdDescriptor) {
            // TODO: This is probably way to simple, do we need a map of devices indication is sent to?
            this._pendingNotificationsAndIndications = {
                completeCallback,
                deviceNotifiedOrIndicated,
                sentAllNotificationsAndIndications: false,
                remainingNotificationCallbacks: 0,
                remainingIndicationConfirmations: 0,
            };

            for (const deviceInstanceId in this._devices) {
                if (Object.prototype.hasOwnProperty.call(this._devices, deviceInstanceId) ||
                    {}.hasOwnProperty.call(this._devices, deviceInstanceId)) {
                    const cccdValue = cccdDescriptor.value[deviceInstanceId][0];
                    const sendIndication = cccdValue & 2;
                    const sendNotification = !sendIndication && (cccdValue & 1);

                    if (sendNotification || sendIndication) {
                        const device = this._devices[deviceInstanceId];
                        const hvxParams = {
                            handle: attribute.valueHandle,
                            type: sendIndication || sendNotification,
                            offset,
                            len: value.length,
                            data: value,
                        };
                        sentHvx = true;

                        if (sendNotification) {
                            this._pendingNotificationsAndIndications.remainingNotificationCallbacks += 1;
                        } else if (sendIndication) {
                            this._pendingNotificationsAndIndications.remainingIndicationConfirmations += 1;
                        }

                        this._adapter.gattsHVX(device.connectionHandle, hvxParams, err => {
                            if (err) {
                                if (sendNotification) {
                                    this._pendingNotificationsAndIndications.remainingNotificationCallbacks -= 1;
                                } else if (sendIndication) {
                                    this._pendingNotificationsAndIndications.remainingIndicationConfirmations -= 1;
                                }

                                this.emit('error', _makeError('Failed to send notification', err));

                                if (this._sendingNotificationsAndIndicationsComplete()) {
                                    completeCallback(_makeError('Failed to send notification or indication', err));
                                    this._pendingNotificationsAndIndications = {};
                                }

                                return;
                            }

                            this._setAttributeValueWithOffset(attribute, value, offset);

                            if (sendNotification) {
                                if (deviceNotifiedOrIndicated) {
                                    deviceNotifiedOrIndicated(device, attribute);
                                }

                                this.emit('deviceNotifiedOrIndicated', device, attribute);

                                this._pendingNotificationsAndIndications.remainingNotificationCallbacks -= 1;
                                if (this._sendingNotificationsAndIndicationsComplete()) {
                                    completeCallback(undefined);
                                    this._pendingNotificationsAndIndications = {};
                                }
                            } else if (sendIndication) {
                                return;
                            }
                        });
                    }
                }
            }

            this._pendingNotificationsAndIndications.sentAllNotificationsAndIndications = true;
        }

        if (sentHvx) {
            if (this._sendingNotificationsAndIndicationsComplete()) {
                completeCallback(undefined);
                this._pendingNotificationsAndIndications = {};
            }

            return;
        }

        this._adapter.gattsSetValue(this._bleDriver.BLE_CONN_HANDLE_INVALID, attribute.handle, writeParameters, err => {
            if (err) {
                this.emit('error', _makeError('Failed to write local value', err));
                completeCallback(err, undefined);
                return;
            }

            this._setAttributeValueWithOffset(attribute, value, offset);
            completeCallback(undefined, attribute);
        });
    }

    _readLocalValue(attribute, callback) {
        const readParameters = {
            len: 512,
            offset: 0,
            value: [],
        };

        this._adapter.gattsGetValue(this._bleDriver.BLE_CONN_HANDLE_INVALID, attribute, readParameters,
            (err, readResults) => {
                if (err) {
                    this.emit('error', _makeError('Failed to write local value', err));

                    if (_isCallback(callback)) {
                        callback(err, undefined);
                    }

                    return;
                }

                attribute.value = readResults.value;
                if (_isCallback(callback)) {
                    callback(undefined, attribute);
                }
            }
        );
    }

    /**
     * Starts notifications on a GATT characteristic.
     *
     * Only for GATT central role.
     *
     * @param {string} characteristicId Unique ID of the GATT characteristic.
     * @param {boolean} requireAck Require all notifications to ack.
     * @param {function} callback Callback signature: err => {} (not called until ack is received if `requireAck`).
     * @returns {void}
     */
    startCharacteristicsNotifications(characteristicId, requireAck, callback) {
        const enableNotificationsBitfield = requireAck ? 2 : 1;

        const characteristic = this._characteristics[characteristicId];
        if (!characteristic) {
            throw new Error(`Disabling characteristic's notifications failed: 
                             Could not get the characteristic with Id: ${characteristicId}.`);
        }

        const cccdDescriptor = this._getCCCDOfCharacteristic(characteristicId);
        // TODO: If CCCD has not been discovered do a descriptor discovery
        if (!cccdDescriptor) {
            throw new Error(`Disabling characteristic's notifications failed:
                             Could not find the CCCD with parent characteristic Id: ${characteristicId}.`);
        }

        this.writeDescriptorValue(cccdDescriptor.instanceId, [enableNotificationsBitfield, 0], true, err => {
            if (err) {
                this.emit('error', 'Failed to start characteristic\'s notifications');
            }

            if (_isCallback(callback)) {
                callback(err);
            }
        });
    }

    /**
     * Disables notifications on a GATT characteristic.
     *
     * @param {string} characteristicId Unique ID of the GATT characteristic.
     * @param {function} callback Callback signature: err => {}.
     * @returns {void}
     */
    stopCharacteristicsNotifications(characteristicId, callback) {
        const disableNotificationsBitfield = 0;

        const characteristic = this._characteristics[characteristicId];
        if (!characteristic) {
            throw new Error(`Disabling characteristic's notifications failed: 
                             Could not get the characteristic with Id: ${characteristicId}.`);
        }

        const cccdDescriptor = this._getCCCDOfCharacteristic(characteristicId);
        if (!cccdDescriptor) {
            throw new Error(`Disabling characteristic's notifications failed:
                             Could not find the CCCD with parent characteristic Id: ${characteristicId}.`);
        }

        this.writeDescriptorValue(cccdDescriptor.instanceId, [disableNotificationsBitfield, 0], true, err => {
            if (err) {
                this.emit('error', 'Failed to stop characteristic\'s notifications');
            }

            if (_isCallback(callback)) {
                callback(err);
            }
        });
    }
}

module.exports = Adapter;
