# Absolute center of the current jetway
# The property that the jetway is tied to will be a function of these coordinates
# These are the only things that should change throughout this script
# NOTE: jetways face 270 degrees by default, so ensure to add 270 degrees to the heading before calculations
var jetwayLongitude = 0;
var jetwayLatitude = 0;
var jetwayAltitude = 0;
var jetwayHeading = 0;
var distMainHandleInit = 0;
var distMainHandleFinal = 0;
var distSecondaryHandle = 0;
var centerWheelsGroundLock = 0;
var jetwayLimits = [0, 0]; # length and height
var jetwayId = "";
var jetwaySpeed = 0.1; # meters per second
var jetwayPropNode = "scone/jetway-" ~ jetwayId;

print("moving " ~ jetwayId);

# Initial position of the aircraft
var longitude = getprop("position/longitude-deg");
var latitude = getprop("position/latitude-deg");
var altitude_m = getprop("position/altitude-ft") * 0.3048;
var heading = getprop("orientation/heading-deg");
var direction = getprop(jetwayPropNode ~ "/direction");

# List of doors defined on the aircraft
var doors = [];
while (true) {
	var currentIndex = size(doors);
	if (getprop("sim/model/door[" ~ currentIndex ~ "]/position-x-m") == nil
		or getprop("sim/model/door[" ~ currentIndex ~ "]/position-y-m") == nil
		or getprop("sim/model/door[" ~ currentIndex ~ "]/position-z-m") == nil) {
		break;
	}
	append(doors, [
			getprop("sim/model/door[" ~ currentIndex ~ "]/position-x-m"),
			getprop("sim/model/door[" ~ currentIndex ~ "]/position-y-m"),
			getprop("sim/model/door[" ~ currentIndex ~ "]/position-z-m")
		]);
}
if (size(doors) == 0) {
	gui.popupTip("Cannot extend jetway: Your aircraft does not define the required positioning information.");
}
# Change the position of the aircraft doors to absolute coordinates
for (var i = 0; i < size(doors); i+=1) {
	var door = doors[i];
	var doorLongitude = longitude + (door[0] / (111320 * math.cos(latitude * 3.141592653589793 / 180)));
	var doorLatitude = latitude + (door[1] / 110540);
	var doorAltitude = altitude_m + door[2];
	doors[i] = [doorLongitude, doorLatitude, doorAltitude];
}

# Find the closest door to the jetway's end and see if it is within the constraints
var closestDoorIndex = -1;
var closestDoorDistance = 1000000;
var closestDoorPivotPoint = [0, 0, 0];
for (var i = 0; i < size(doors); i+=1) {
	var door = doors[i];
	# Actually calculate the distance the jetway would have to extend to reach the door
	var R = 6371000; # Earth radius in meters

	# Use haversine formula for horizontal distance in meters
	var phi1 = jetwayLatitude * math.pi / 180;
	var phi2 = door[1] * math.pi / 180;
	var deltaPhi = (door[1] - jetwayLatitude) * math.pi / 180;
	var deltaLambda = (door[0] - jetwayLongitude) * math.pi / 180;

	var a = math.sin(deltaPhi / 2) * math.sin(deltaPhi / 2) +
	math.cos(phi1) * math.cos(phi2) *
	math.sin(deltaLambda / 2) * math.sin(deltaLambda / 2);
	var c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
	var horizontalDistance = R * c;

	# Combine horizontal distance with vertical distance
	var distance = math.sqrt(math.pow(horizontalDistance, 2) + math.pow(door[2] - jetwayAltitude, 2));
	if (distance < closestDoorDistance) {
		closestDoorDistance = distance;
		closestDoorIndex = i;
		closestDoorPivotPoint = [door[0], door[1], jetwayAltitude];
	}
}

var currentTime = getprop("sim/time/elapsed-sec");
if (direction == 0) { # Was retracting before, so now we want to extend
	if (closestDoorIndex == -1) {
		gui.popupTip("Cannot extend jetway: No aircraft door was found.");
	} else {
		var closestDoor = doors[closestDoorIndex];
		# Calculate the required extension of the jetway to reach the door
		var R = 6371000; # Earth radius in meters
		var phi1 = jetwayLatitude * math.pi / 180;
		var phi2 = closestDoorPivotPoint[1] * math.pi / 180;
		var deltaPhi = (closestDoorPivotPoint[1] - jetwayLatitude) * math.pi / 180;
		var deltaLambda = (closestDoorPivotPoint[0] - jetwayLongitude) * math.pi / 180;

		var a = math.sin(deltaPhi / 2) * math.sin(deltaPhi / 2) + math.cos(phi1) * math.cos(phi2) *
		math.sin(deltaLambda / 2) * math.sin(deltaLambda / 2);
		var c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
		var horizontalDistance = R * c;

		var requiredExtension = math.sqrt(math.pow(horizontalDistance, 2) + math.pow(closestDoorPivotPoint[2] - jetwayAltitude, 2));
		var requiredHeading = math.mod(math.atan2(closestDoorPivotPoint[0] - jetwayLongitude, closestDoorPivotPoint[1] - jetwayLatitude) * 180 / math.pi + 360, 360);
		if (requiredExtension > distMainHandleFinal) {
			gui.popupTip("Cannot extend jetway: The closest door is " ~ math.round(requiredExtension, 2) ~ " meters away, which exceeds the maximum extension limit of " ~ math.round(distMainHandleFinal, 2) ~ " meters.");
		} else if (requiredExtension < distMainHandleInit) {
			gui.popupTip("Cannot extend jetway: The closest door is " ~ math.round(requiredExtension, 2) ~ " meters away, which is less than the minimum extension limit of " ~ math.round(distMainHandleInit, 2) ~ " meters.");
		} else if (heading - jetwayHeading > 100) {
			gui.popupTip("Cannot extend jetway: The hood would rotate " ~ (math.abs(heading - jetwayHeading - 100)) ~ " degrees past its bounds.")
		} else if (requiredHeading - jetwayHeading > 80) {
			gui.popupTip("Cannot extend jetway: The jetway would rotate " ~ (math.abs(heading - jetwayHeading - 80)) ~ " degrees past its bounds.")
		} else {
			# Extend the jetway to the required extension
			setprop(jetwayPropNode ~ "/extension-delta-m", requiredExtension - distMainHandleInit);
			setprop(jetwayPropNode ~ "/secondary-handle-rotation-deg", heading - jetwayHeading);
			setprop(jetwayPropNode ~ "/main-handle-rotation-deg", requiredHeading - jetwayHeading);
			setprop(jetwayPropNode ~ "/target-time-extension", currentTime);
			setprop(jetwayPropNode ~ "/target-time-main-handle", currentTime);
			setprop(jetwayPropNode ~ "/target-time-secondary-handle", currentTime);
			setprop(jetwayPropNode ~ "/direction", 1); # extending
		}
	}
} else { # Was extending before, so now we want to retract
	# We know how fast the jetway moves and how far it needs to go,
	# so set the target time for the jetway to be fully retracted
	# Main handle moves at 0.1 m/s and rotates at 5 deg/s
	# Secondary handle rotates at 10 deg/s
	var prevTargetTime = getprop(jetwayPropNode ~ "/target-time-extension");
	var extensionAtRetraction = math.clamp(0.1 * (currentTime - prevTargetTime), 0, getprop(jetwayPropNode ~ "/extension-delta-m"));
	var mainHandleRotAtRetraction = math.clamp(5 * (currentTime - prevTargetTime), 0, getprop(jetwayPropNode ~ "/main-handle-rotation-deg"));
	var secondaryHandleRotAtRetraction = math.clamp(10 * (currentTime - prevTargetTime), 0, getprop(jetwayPropNode ~ "/secondary-handle-rotation-deg"));
	setprop(jetwayPropNode ~ "/extension-delta-m", extensionAtRetraction);
	setprop(jetwayPropNode ~ "/secondary-handle-rotation-deg", mainHandleRotAtRetraction);
	setprop(jetwayPropNode ~ "/main-handle-rotation-deg", secondaryHandleRotAtRetraction);
	setprop(jetwayPropNode ~ "/target-time-extension", currentTime + (10 * extensionAtRetraction));
	setprop(jetwayPropNode ~ "/target-time-main-handle", currentTime + (mainHandleRotAtRetraction / 5));
	setprop(jetwayPropNode ~ "/target-time-secondary-handle", currentTime + (secondaryHandleRotAtRetraction / 10));
	setprop(jetwayPropNode ~ "/direction", 0); # retracting
}
