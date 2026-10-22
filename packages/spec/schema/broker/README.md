# Local broker JSON Schemas

These schemas describe the local broker socket protocol in SPEC.md sections 5
through 9 and Appendices A, B and C, including fleet notifications from section
5.4. The schemas follow SPEC.md, the protocol source of truth. Where the reference
broker's observed wire form differs, the schema accepts it and NOTES.txt records
the gap for resolution, along with validation limits.

frames.schema.json defines requests, success and error responses, fleet
notifications and error codes. types.schema.json defines shared wire shapes.
Each file in methods defines Params and Result for the method named by its
file. index.json lists all methods in sorted order.

The schemas use the draft 2020-12 keyword subset: $schema, $id, $defs, $ref,
title, description, type, enum, const, properties, required,
additionalProperties, items, minItems, maxItems, minLength, maxLength, pattern,
minimum, maximum, oneOf, anyOf and format. The only format is date-time.
References resolve within a file or to the shared schema files.

Defined result objects and parameters are closed, except for grant conveyance
fields (SPEC 9.1). Informative broker and bridge details and policy file values
remain open. Maps constrain their values while allowing dynamic keys. Optional fields may be absent; nullable fields also accept null.

The conformance suite in packages/conformance validates every frame against
these schemas. Schemas describe JSON shapes. Stateful authorization, filesystem
checks, credential checks and byte limits remain broker responsibilities.
