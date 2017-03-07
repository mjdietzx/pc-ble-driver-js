# Global





* * *

## Class: AdapterFactory
Shall not be called by user. Called by the factory method `this.getInstance()`.

### AdapterFactory.getInstance(bleDrivers) 

Get the singleton `AdapterFactory` instance.

**Parameters**

**bleDrivers**: `null | Object`, Optional object mapping version to pc-ble-driver AddOn.

**Returns**: `AdapterFactory`, The singleton `AdapterFactory` instance.

### AdapterFactory.getAdapters(callback) 

Get connected adapters.

**Parameters**

**callback**: `null | function`, Optional callback signature: (err, adapters) => {}.

**Returns**: `void`



* * *










