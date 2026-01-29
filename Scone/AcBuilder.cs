using System.Numerics;

namespace Scone;

public class AcBuilder
{
	public string Header { get; private set; } = "AC3Db";
	public List<Material> Materials { get; private set; } = [];
	public List<Object> Objects { get; private set; } = [];

	public AcBuilder() { }

	public Material AddMaterial()
	{
		Material mat = new();
		Materials.Add(mat);
		return mat;
	}

	public Object AddObject(string name)
	{
		Object obj = new(name);
		Objects.Add(obj);
		return obj;
	}

	public class Object
	{
		public ulong Kids { get; private set; } = 0;
		public string Name { get; private set; } = "";
		public List<World> Worlds { get; private set; } = [];

		public Object() { }
		public Object(string name)
		{
			Name = name;
		}
	}

	public class World : Object
	{
		public World() { }
	}

	public class Poly : Object
	{

	}

	public class Group : Object
	{

	}

	public struct Material
	{
		public string? Name;
		public Vector3 Rgb;
		public Vector3 Ambient;
		public Vector3 Emissive;
		public Vector3 Specular;
		public float Shininess;
		public float Transparency;
	}
}