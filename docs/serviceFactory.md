# Global





* * *

## Class: ServiceFactory


### ServiceFactory.createService(uuid, serviceType) 

Factory method to create a service in the Bluetooth `Device's` 'local.server' GATT attribute table.

**Parameters**

**uuid**: `string`, A 128-bit or 16-bit unique identifier for this service.

**serviceType**: `string`, The server service type. 'primary' (default) or `secondary`.

**Returns**: `Service`, A newly created `Service` instance.

### ServiceFactory.createCharacteristic(service, uuid, value, properties, options) 

Factory method to create a characteristic in the Bluetooth `Device's` GATT attribute table.

**Parameters**

**service**: `Service`, The `Service` instance this characteristic is to be added to.

**uuid**: `string`, A 128-bit or 16-bit unique identifier for this characteristic.

**value**: `array`, The initial value of this characteristic.

Available characteristic properties:
- {boolean} broadcast: Broadcasting of the value permitted.
- {boolean} read: Reading the value permitted.
- {boolean} write: Writing the value with Write Request permitted.
- {boolean} writeWoResp: Writing the value with Write Command permitted.
- {boolean} reliableWrite: Writing the value with Queued Write operations permitted.
- {boolean} notify: Notications of the value permitted.
- {boolean} indicate: Indications of the value permitted.
- {boolean} authSignedWr: Writing the value with Signed Write Command permitted.
- {boolean} wrAux: Writing the Characteristic User Description descriptor permitted.

**properties**: `Object`, This GATT characteristic's metadata.

Available characteristic options:
- {string} readPerm: Read permissions.
- {string} writePerm: Write permissions.
- {boolean} variableLength: Variable length attribute.
- {number} maxLength: Maximum attribute value length in bytes, see ref BLE_GATTS_ATTR_LENS_MAX for maximum values.
- {boolean} readAuth: Read authorization and value will be requested from the application on every read operation.
- {boolean} writeAuth: Write authorization will be requested from the application on every Write Request operation (but not Write Command).
Note: vloc = this._bleDriver.BLE_GATTS_VLOC_STACK; // Attribute Value is located in stack memory, no user memory is required.

**options**: `Object`, This GATT characteristic's attribute's metadata.

**Returns**: `Characteristic`, A newly created `Characteristic` instance.

### ServiceFactory.createDescriptor(characteristic, uuid, value, options) 

Factory method to create a descriptor in the Bluetooth `Device's` GATT attribute table.

**Parameters**

**characteristic**: `Characteristic`, The `Characteristic` instance this descriptor is to be added to.

**uuid**: `string`, A 128-bit or 16-bit unique identifier for this descriptor.

**value**: `array`, The initial value of this descriptor.

Available descriptor options:
- {string} readPerm: Read permissions.
- {string} writePerm: Write permissions.
- {boolean} variableLength: Variable length attribute.
- {number} maxLength: Maximum attribute value length in bytes, see ref BLE_GATTS_ATTR_LENS_MAX for maximum values.
- {boolean} readAuth: Read authorization and value will be requested from the application on every read operation.
- {boolean} writeAuth: Write authorization will be requested from the application on every Write Request operation (but not Write Command).
Note: vloc = this._bleDriver.BLE_GATTS_VLOC_STACK; // Attribute Value is located in stack memory, no user memory is required.

**options**: `Object`, This GATT descriptor's attribute's metadata.

**Returns**: `Descriptor`, A newly created `Descriptor` instance.



* * *










