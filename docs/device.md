# Global





* * *

## Class: Device
Create a Bluetooth device.


## Class: Device
Create a Bluetooth device.

**instanceId**:  , Get the instanceId of this device.
**address**:  , Get the bluetooth address of this device. 'local.server': local/adapter, non-'local.server': other device.
**addressType**:  , Get the BLE address type. 'BLE_GAP_ADDR_TYPE_RANDOM_STATIC' (default) or `BLE_GAP_ADDR_TYPE_PUBLIC`.
**role**:  , Get the BLE role of this device. `BLE_GAP_ROLE_CENTRAL` or `BLE_GAP_ROLE_PERIPH`.
**connectionHandle**:  , Get the BLE connection handle of this device.
**connectionHandle**:  , Method that sets `_connectionHandle` and `_instanceId` upon establishing a BLE connection.

Called on `BLE_GAP_EVT_CONNECTED`.
### Device.processEventData(event) 

Method that initializes `Device` as a discovered BLE peripheral.

Called on `BLE_GAP_EVT_ADV_REPORT`.

**Parameters**

**event**: `Object`, Advertising report event received from SoftDevice.

**Returns**: `void`



* * *










