# Global





* * *

## Class: Dfu
Initializes the Dfu controller.


## Class: Dfu
Initializes the Dfu controller.

### Dfu.performDFU(zipFilePath, callback) 

Perform DFU with the given zip file. Successful when callback is invoked with no arguments.

**Parameters**

**zipFilePath**: `string`, Path to zip file containing data for Dfu.

**callback**: `function`, Signature: (err, abort) => {}.

**Returns**: `void`

### Dfu.abort() 

Abort the Dfu procedure.

**Returns**: `void`

### Dfu.getManifest(zipFilePath, callback) 

Get and return manifest object from the given zip file.

The manifest object has one or more of the following properties:
{
  application: {},
  bootloader: {},
  softdevice: {},
  softdevice_bootloader: {},
}

Each of the above properties have the following:
{
  bin_file: <string>, // Firmware filename
  dat_file: <string>, // Init packet filename
}

The softdevice_bootloader property also has:
info_read_only_metadata: {
  bl_size: <integer>, // Bootloader size
  sd_size: <integer>, // Softdevice size
}

**Parameters**

**zipFilePath**: `string`, Path to the zip file.

**callback**: `function`, Signature: (err, manifest) => {}.

**Returns**: `void`



* * *










